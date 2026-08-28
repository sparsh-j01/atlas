/**
 * Ingestion acceptance walk — a REAL file through the REAL route, to `ready`.
 *
 * This is the check the unit suite cannot be: `npm test` covers extraction, chunking,
 * limits and provenance as pure functions, and every one of them passes while the feature
 * is broken end to end. Three defects in M7.5 were invisible to all of them and only
 * appeared here — the bundler rewriting tesseract's worker path, an uncaught worker-spawn
 * exception hanging the request for its whole budget, and a retry that could never advance
 * because the document row still said `failed_<stage>`.
 *
 * NOT part of `npm test`, and deliberately not in CI: it needs a running server, a live
 * Postgres, Supabase Storage credentials and a GEMINI_API_KEY that will be charged for the
 * embedding call. Adding it to the suite would either fail on every machine without those
 * or force them into CI. Run it by hand when the ingestion path changes.
 *
 * Prereqs: a running server (BASE_URL, default http://localhost:3000) and .env.local.
 * It creates its own auth user and its own documents, so it touches nothing of yours.
 *
 *   npm run dev
 *   npx tsx scripts/ingest-smoke.ts <file.pptx|file.pdf>
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { config } from 'dotenv'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { createServerClient } from '@supabase/ssr'
import { formatForMime, FORMATS } from '../lib/ingest/formats'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const DB_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY

// Its own account, so a failed run can never leave rows on a real creator's documents.
const EMAIL = 'ingest-smoke@test.local'

// The password is GENERATED PER RUN and never written down.
//
// A literal here would be a working login to the real project committed in plaintext: the
// Supabase URL and anon key are NEXT_PUBLIC_ and ship in the browser bundle, so email +
// password is the whole credential. Anyone who could read this file could sign in and spend
// the project's Gemini quota. Rotating on every run means there is nothing to steal and no
// long-lived account left behind with a known password.
const PASSWORD = `smoke-${randomUUID()}-Aa1!`

const PAGE_SEPARATOR = '\n\n'

function mimeFor(file: string): string {
  const ext = path.extname(file).slice(1).toLowerCase()
  const format = FORMATS.find((f) => f.extension === ext)
  assert.ok(format, `unsupported file type ".${ext}" — accepted: ${FORMATS.map((f) => f.extension).join(', ')}`)
  return format.mimeType
}

/** Sign in, and encode the session with @supabase/ssr's OWN cookie writer so the format is
 *  exactly what the route's server client will read back. */
async function authCookie(): Promise<string> {
  const admin = createClient(SUPABASE_URL!, SERVICE!, { auth: { persistSession: false } })
  const { data: list } = await admin.auth.admin.listUsers()
  const existing = list.users.find((u) => u.email === EMAIL)
  if (existing) {
    // Reset to this run's password, so a previous run's secret stops working the moment
    // this one starts.
    const { error } = await admin.auth.admin.updateUserById(existing.id, { password: PASSWORD })
    assert.ok(!error, `updateUser: ${error?.message}`)
  } else {
    const { error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    })
    assert.ok(!error, `createUser: ${error?.message}`)
  }

  const anon = createClient(SUPABASE_URL!, ANON!, { auth: { persistSession: false } })
  const { data, error } = await anon.auth.signInWithPassword({ email: EMAIL, password: PASSWORD })
  assert.ok(!error, `signIn: ${error?.message}`)

  const jar: Record<string, string> = {}
  const recorder = createServerClient(SUPABASE_URL!, ANON!, {
    cookies: {
      getAll: () => Object.entries(jar).map(([name, value]) => ({ name, value })),
      setAll: (list) => list.forEach(({ name, value }) => { jar[name] = value }),
    },
  })
  await recorder.auth.setSession({
    access_token: data.session!.access_token,
    refresh_token: data.session!.refresh_token,
  })
  return Object.entries(jar).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ')
}

async function main() {
  const file = process.argv[2]
  assert.ok(file, 'usage: tsx scripts/ingest-smoke.ts <file.pptx|file.pdf>')
  for (const [name, value] of Object.entries({ DB_URL, SUPABASE_URL, ANON, SERVICE }))
    assert.ok(value, `${name} is required — is .env.local filled in?`)

  const mime = mimeFor(file)
  const format = formatForMime(mime)!
  const cookie = await authCookie()
  const sql = postgres(DB_URL!, { prepare: false })

  try {
    // --- Upload through the real route: auth, size ladder, magic bytes, probe, storage ---
    const form = new FormData()
    form.append('file', new File([new Uint8Array(readFileSync(file))], path.basename(file), { type: mime }))
    const up = await fetch(`${BASE_URL}/api/decks/ingest`, { method: 'POST', body: form, headers: { cookie } })
    const uploaded = await up.json()
    assert.equal(up.status, 200, `upload failed: ${JSON.stringify(uploaded)}`)
    const id: string = uploaded.documentId
    console.log(`uploaded  ${path.basename(file)} → ${id} (${uploaded.pageCount} ${format.unit}s)`)

    // --- Drive the resumable pipeline exactly as the browser does ---
    let coverage: { totalPages: number; readPages: number; message: string } | undefined
    for (let i = 0; i < 40; i++) {
      const res = await fetch(`${BASE_URL}/api/documents/${id}/process`, { method: 'POST', headers: { cookie } })
      const step = await res.json()
      console.log(`  ${step.status}${step.paused ? ' (paused)' : ''}`)
      assert.ok(!step.error, `ingestion failed: ${step.error}`)
      if (step.done) { coverage = step.coverage; break }
      assert.ok(step.paused, `stopped at "${step.status}" without pausing`)
    }

    // --- Verify what actually landed, rather than trusting the response ---
    const [doc] = await sql`select * from documents where id = ${id}`
    assert.equal(doc.status, 'ready', 'document never reached ready')
    assert.equal(doc.source_type, format.id)
    // The storage object is namespaced by owner: that prefix IS the storage RLS boundary.
    assert.ok(doc.storage_path.startsWith(`${doc.owner_id}/`), 'storage path is not owner-scoped')

    const pages = await sql`select page_number, raw_text, ocr_text, text_source, unread_reason
      from document_pages where document_id = ${id} order by page_number`
    assert.ok(pages.length > 0, 'no pages')
    // Dense and 1-based: an unreadable page still occupies its number, or every citation
    // after it points at the wrong page.
    pages.forEach((p, i) => assert.equal(p.page_number, i + 1, 'page numbering is not dense'))

    const assets = await sql`select * from document_assets where document_id = ${id}`
    if (format.id === 'pdf') assert.equal(assets.length, 0, 'a PDF must record no assets')
    for (const a of assets) {
      assert.ok(a.entry_path.startsWith('ppt/media/'), `asset outside ppt/media: ${a.entry_path}`)
      assert.ok(['pending', 'done', 'skipped', 'failed'].includes(a.ocr_status))
    }

    const chunks = await sql`select chunk_index, char_start, char_end, text, page_start
      from chunks where document_id = ${id} order by chunk_index`
    assert.ok(chunks.length > 0, 'no chunks')

    const [{ n: embeddings }] = await sql`select count(*)::int as n from embeddings e
      join chunks c on c.id = e.chunk_id where c.document_id = ${id}`
    assert.equal(embeddings, chunks.length, 'every chunk must have an embedding')

    // --- THE invariant: rebuild document text the way readPages() does, then slice ---
    const fullText = pages
      .map((p) => {
        const raw = p.raw_text as string
        const ocr = p.ocr_text as string | null
        if (!ocr) return raw
        return raw.trim().length > 0 ? `${raw}\n${ocr}` : ocr
      })
      .join(PAGE_SEPARATOR)
    for (const c of chunks)
      assert.equal(fullText.slice(c.char_start, c.char_end), c.text, `chunk ${c.chunk_index} does not slice back`)

    const ocrPages = pages.filter((p) => p.text_source !== 'digital')
    console.log(
      `verified  ${pages.length} pages · ${assets.length} assets · ${chunks.length} chunks · ` +
      `${embeddings} embeddings · ${ocrPages.length} OCR-derived · provenance ${chunks.length}/${chunks.length}`,
    )
    if (coverage?.message) console.log(`coverage  ${coverage.message}`)
    console.log('PASS')
  } finally {
    await sql.end()
  }
}

main().catch((e) => {
  console.error('FAIL:', e.message)
  process.exit(1)
})
