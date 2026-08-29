import { NextResponse } from 'next/server'
import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { getAuthUser } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { sha256 } from '@/lib/crypto'
import { logger } from '@/lib/logger'
import {
  UPLOAD_LIMITS,
  createDocument,
  createIngestionJob,
  getDocumentByHash,
  getLatestJob,
} from '@/lib/documents'
import { acceptedLabels, formatForMime, matchesMagic } from '@/lib/ingest/formats'

// Upload a source document and queue it for ingestion (M7 phase 1; PPTX added in M7.5).
//
// An uploaded file is hostile input from an unauthenticated-shaped source, so the checks
// run CHEAPEST-FIRST and each one gates the next:
//
//   Content-Length ─> declared type ─> read bytes ─> size ─> magic bytes ─> probe ─> pages
//
// Order matters as much as the checks do. Previously the 25MB limit was enforced AFTER
// `file.arrayBuffer()` had buffered the whole upload and unpdf had parsed it, so a 500MB
// file was fully read into a serverless function's memory and handed to the parser before
// anything objected — the limit protected storage, not the process.
//
// What each rung compares against now comes from lib/ingest/formats.ts rather than from
// constants inlined here, so adding a format cannot leave one rung behind. The ladder
// itself is unchanged.
//
// The magic-byte rung is weaker for PPTX than for PDF and that is expected: every OOXML
// file begins with the same four zip bytes, so a .docx renamed to .pptx gets past it. The
// probe is what refuses it, on having no slides — which is the same shape of check as
// "this PDF has no text layer", just one rung later.
//
// CSRF: the credential is the Supabase auth cookie (SameSite=Lax) and this route is
// POST-only, so a cross-site submission carries no session and 401s.

export const maxDuration = 60

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/** Documents one account may upload per hour.
 *
 *  Both generation routes already cap themselves at 10/hour against the decks table, but
 *  ingestion is the more expensive half and had no ceiling at all: every accepted upload
 *  buys 25MB of storage plus, once processed, one Gemini structure-detection call per 40k
 *  characters and an embedding call for every chunk. The content-hash dedupe is not a
 *  limit — it only catches byte-identical re-uploads, and one flipped byte is a new
 *  document with a fresh MAX_INGESTION_ATTEMPTS budget. So a single signed-in account
 *  could spend the project's whole provider quota in a loop.
 *
 *  20, not 10: uploading is how a teacher gets material in, and they may reasonably load a
 *  term's worth of slides in one sitting. It is a ceiling on abuse, not a usage budget.
 *  ponytail: counted per hour against created_at, same shape as GENERATIONS_PER_HOUR and
 *  correct across serverless instances because the rows are the state. Per-account storage
 *  totals are the next limit worth adding, once anything actually bills for them. */
const UPLOADS_PER_HOUR = 20

export async function POST(req: Request) {
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to upload a document.')

  // Before reading the body: a rejected upload should cost nothing to refuse.
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.ownerId, user.id), gt(documents.createdAt, hourAgo)))
  if (n >= UPLOADS_PER_HOUR)
    return bad(429, `Upload limit reached (${UPLOADS_PER_HOUR}/hour). Try again later.`)

  // Reject on the DECLARED length before reading a single byte. Cheap, and it is the only
  // check that can refuse an oversized upload without paying for it first.
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > UPLOAD_LIMITS.maxFileSize)
    return bad(413, `File too large. Maximum ${UPLOAD_LIMITS.maxFileSize / 1024 / 1024}MB.`)

  let file: File | null
  try {
    file = (await req.formData()).get('file') as File | null
  } catch {
    return bad(400, 'Expected a multipart form upload.')
  }
  if (!file) return bad(400, 'No file provided.')

  const format = formatForMime(file.type)
  if (!format) return bad(415, `Only ${acceptedLabels()} uploads are accepted.`)

  // File.size is known without reading the body, so this catches a lying Content-Length.
  if (file.size > UPLOAD_LIMITS.maxFileSize)
    return bad(413, `File too large. Maximum ${UPLOAD_LIMITS.maxFileSize / 1024 / 1024}MB.`)
  if (file.size === 0) return bad(400, 'That file is empty.')

  const buffer = Buffer.from(await file.arrayBuffer())
  // Belt and braces: the two checks above are both self-reported by the client.
  if (buffer.length > UPLOAD_LIMITS.maxFileSize)
    return bad(413, `File too large. Maximum ${UPLOAD_LIMITS.maxFileSize / 1024 / 1024}MB.`)
  // Content sniffing, because a declared Content-Type is just a string the caller chose.
  if (!matchesMagic(format, buffer)) return bad(415, `That file is not a ${format.label}.`)

  // Parse far enough to know the file is usable, and no further. For a .pptx this also
  // walks the archive under the decompression limits, so a zip bomb is refused here rather
  // than inside the ingestion pipeline.
  const check = await format.probe(buffer, UPLOAD_LIMITS.maxPages)
  if (!check.ok) return bad(422, check.error)

  const contentHash = await sha256(buffer)

  // Same bytes from the same owner: reuse the document rather than storing it twice. If a
  // previous run failed, hand back a fresh job so the caller can drive it again.
  const existing = await getDocumentByHash(user.id, contentHash)
  if (existing) {
    const job = (await getLatestJob(existing.id)) ?? (await createIngestionJob(existing.id))
    return NextResponse.json({
      documentId: existing.id,
      jobId: job.id,
      status: existing.status,
      pageCount: existing.pageCount,
      duplicate: true,
    })
  }

  const admin = createAdminClient()
  const storagePath = `${user.id}/${contentHash}.${format.extension}`
  const { error: uploadError } = await admin.storage
    .from('documents')
    .upload(storagePath, buffer, { contentType: format.mimeType, upsert: false })
  // The Supabase error text names the bucket and the storage backend. Keep it in the log.
  if (uploadError) {
    logger.error('document upload failed', {
      ownerId: user.id,
      format: format.id,
      reason: uploadError.message,
    })
    return bad(502, 'Could not store the upload. Try again.')
  }

  // The object exists but nothing references it yet. If either row fails to write, remove
  // it — otherwise it is unreachable, uncountable and paid for indefinitely.
  try {
    const doc = await createDocument({
      ownerId: user.id,
      filename: file.name.slice(0, 255),
      sourceType: format.id,
      fileSize: buffer.length,
      pageCount: check.pageCount,
      contentHash,
      storagePath,
    })
    const job = await createIngestionJob(doc.id)
    return NextResponse.json({
      documentId: doc.id,
      jobId: job.id,
      status: 'uploaded',
      pageCount: check.pageCount,
      duplicate: false,
    })
  } catch (e) {
    await admin.storage.from('documents').remove([storagePath]).catch(() => {})
    throw e
  }
}
