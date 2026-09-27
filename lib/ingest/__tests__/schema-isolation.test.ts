import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The tenant boundary for anything M7.5 adds, checked against the migrations that create
// it. The live database was verified directly after `db:migrate`; this is the guard that
// keeps a LATER migration from quietly widening it, which no amount of app-side testing
// would notice.
//
// M7's own isolation eval is untouched — see evals/security/. This covers only the new
// table and the new storage allowlist.

const MIGRATIONS_DIR = path.join(process.cwd(), 'lib', 'db', 'migrations')

const allSql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }))

const combined = allSql.map((m) => m.sql).join('\n')

/** The policies left after every migration has run, in order: CREATE adds, DROP removes.
 *  Parsed one statement at a time — matching across the whole file lets a lazy regex run
 *  from one statement's name into a later statement's role list. Counting CREATEs alone
 *  reported policies that migration 0011 drops, so the final state is what gets checked. */
const norm = (t: string) => t.replace(/"/g, '')
const finalPolicies = new Map<string, { name: string; table: string; roles: string; restrictive: boolean; statement: string }>()
for (const statement of combined.match(/(?:CREATE|DROP) POLICY[\s\S]*?;/g) ?? []) {
  const name = statement.match(/POLICY\s+(?:IF EXISTS\s+)?"([^"]+)"/)?.[1] ?? ''
  const table = norm(statement.match(/\sON\s+([\w."]+)/)?.[1] ?? '')
  if (statement.startsWith('DROP')) {
    finalPolicies.delete(`${table}:${name}`)
    continue
  }
  const roles = statement.match(/\bTO\s+([\w,\s]+?)(?:\s+USING|\s+WITH|\s*$)/)?.[1]?.trim() ?? ''
  finalPolicies.set(`${table}:${name}`, { name, table, roles, restrictive: /\bAS RESTRICTIVE\b/.test(statement), statement })
}
const policyStatements = [...finalPolicies.values()]
const permissive = policyStatements.filter((p) => !p.restrictive)

// Restrictive policies only take access away, so naming anon in one grants nothing. Each is
// listed here by name: a new restrictive policy has to be added deliberately, not waved through.
const RESTRICTIVE_GUARDS = ['documents_objects_no_client_insert', 'documents_objects_no_client_update', 'documents_objects_no_client_delete']

describe('document_assets tenant isolation', () => {
  it('has row level security enabled', () => {
    expect(combined).toMatch(/ALTER TABLE "document_assets" ENABLE ROW LEVEL SECURITY/)
  })

  it('ends with one read-only policy, ownership resolved back to documents.owner_id', () => {
    // An owner_id column on this table would be a second source of truth that could drift
    // from the document's. Read-only since 0011: writes are server-only (see below).
    const assetPolicies = policyStatements.filter((p) => p.table === 'document_assets')
    expect(assetPolicies.map((p) => p.name)).toEqual(['document_assets_read_own'])
    expect(assetPolicies[0].statement).toMatch(/FOR SELECT TO authenticated/)
    expect(assetPolicies[0].statement).toContain('FROM documents d')
    expect(assetPolicies[0].statement).toContain('d.owner_id = auth.uid()')
  })

  it('cascades from the document, so deleting a document takes its assets with it', () => {
    expect(combined).toMatch(
      /"document_assets" ADD CONSTRAINT "document_assets_document_id_documents_id_fk"[\s\S]*?ON DELETE cascade/,
    )
  })
})

describe('server-managed tables (security review F01/F07)', () => {
  it('revokes every client write on the workflow, content and accounting tables', () => {
    // RLS let an owner UPDATE their own document row, storage_path included, which the
    // service role then trusted to download or delete another creator's file.
    const revoke = combined.match(/REVOKE INSERT, UPDATE, DELETE[\s\S]*?;/)?.[0] ?? ''
    for (const table of ['documents', 'document_pages', 'document_assets', 'document_sections', 'chunks', 'embeddings', 'generation_sources', 'ingestion_jobs', 'ai_usage', 'entitlements', 'rate_limits'])
      expect(revoke, table).toMatch(new RegExp(`\\b${table}\\b`))
    expect(revoke).toMatch(/FROM anon, authenticated, PUBLIC/)
  })

  it('leaves no client write policy on those tables', () => {
    for (const p of permissive.filter((p) => !p.table.startsWith('realtime.') && !p.table.startsWith('storage.')))
      if (['documents', 'document_pages', 'document_assets', 'document_sections', 'chunks', 'embeddings', 'generation_sources', 'ingestion_jobs'].includes(p.table))
        expect(p.statement, p.name).toMatch(/FOR SELECT/)
  })
})

describe('no anon policy on a data table', () => {
  it('parsed every policy in the schema', () => {
    expect(policyStatements.length).toBeGreaterThan(10)
    for (const p of policyStatements) {
      expect(p.name, p.statement.slice(0, 60)).toBeTruthy()
      expect(p.roles, p.name).toBeTruthy()
    }
  })

  it('grants nothing to anon on any table holding creator or document data', () => {
    // The anon key is public. A single `TO anon` policy on a document table would make
    // every uploaded lecture readable by anyone holding it.
    //
    // realtime.messages is deliberately excluded and deliberately different: anonymous
    // participants MUST receive broadcasts and write presence to play, and migration 0005
    // grants exactly that, scoped to session: topics. That is the transport, not the data.
    for (const p of permissive) {
      if (p.table.startsWith('realtime.')) continue
      expect(p.roles, `policy "${p.name}" on ${p.table}`).toBe('authenticated')
    }
  })

  it('names every restrictive policy, and each one only denies the documents bucket', () => {
    const restrictive = policyStatements.filter((p) => p.restrictive)
    expect(restrictive.map((p) => p.name).sort()).toEqual([...RESTRICTIVE_GUARDS].sort())
    for (const p of restrictive) expect(p.statement, p.name).toContain("bucket_id <> 'documents'")
  })

  it('confirms realtime is the ONLY place anon is granted anything', () => {
    // If a future migration adds an anon grant somewhere else, this is what notices.
    const withAnon = permissive.filter((p) => /\banon\b/.test(p.roles))
    expect(withAnon.map((p) => p.table)).toEqual(['realtime.messages', 'realtime.messages'])
  })
})

describe('storage bucket allowlist', () => {
  it('accepts pdf and pptx, and nothing else', () => {
    const update = combined.match(/UPDATE storage\.buckets[\s\S]*?WHERE id = 'documents';/)?.[0] ?? ''
    expect(update).toBeTruthy()
    expect(update).toContain("'application/pdf'")
    expect(update).toContain(
      "'application/vnd.openxmlformats-officedocument.presentationml.presentation'",
    )
    // Storage enforces this list before app code runs. A wildcard here would let any file
    // type into the bucket regardless of what the upload route decided.
    expect(update).not.toContain('*')
    expect(update).not.toMatch(/allowed_mime_types\s*=\s*NULL/i)
  })

  it('keeps the bucket private and the size limit where it was', () => {
    expect(combined).toMatch(/INSERT INTO storage\.buckets[\s\S]*?'documents',\s*false,\s*26214400/)
    // Nothing may flip it public or raise the cap in a later migration.
    expect(combined).not.toMatch(/UPDATE storage\.buckets\s+SET public\s*=\s*true/i)
    expect(combined).not.toMatch(/UPDATE storage\.buckets\s+SET file_size_limit/i)
  })

  it('widens the bucket in a new migration rather than editing the one that created it', () => {
    // 0007 has already been applied. Editing it would leave every existing database on the
    // old definition with no way to notice.
    const creator = allSql.find((m) => m.sql.includes('INSERT INTO storage.buckets'))!
    const widener = allSql.find((m) => m.sql.includes('UPDATE storage.buckets'))!
    expect(creator.file).toBe('0007_busy_scarlet_witch.sql')
    expect(widener.file > creator.file).toBe(true)
  })
})

describe('the immutable source column', () => {
  it('adds ocr_text as a separate nullable column, leaving raw_text alone', () => {
    // raw_text is documented as immutable in schema.ts. OCR output going into it would
    // rewrite what the file actually contained, and shift every existing chunk offset.
    expect(combined).toMatch(/ALTER TABLE "document_pages" ADD COLUMN "ocr_text" text;/)
    expect(combined).not.toMatch(/ALTER TABLE "document_pages"[^;]*(DROP|ALTER) COLUMN "raw_text"/)
    expect(combined).not.toMatch(/UPDATE "?document_pages"?\s+SET\s+raw_text/i)
  })

  it('defaults text_source to digital, so existing rows keep their meaning', () => {
    expect(combined).toMatch(/ADD COLUMN "text_source" text DEFAULT 'digital' NOT NULL/)
  })
})
