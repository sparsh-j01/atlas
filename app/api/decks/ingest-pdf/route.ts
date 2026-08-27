import { NextResponse } from 'next/server'
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

// Upload a PDF and queue it for ingestion (M7 phase 1).
//
// An uploaded file is hostile input from an unauthenticated-shaped source, so the checks
// run CHEAPEST-FIRST and each one gates the next:
//
//   Content-Length ─> declared type ─> read bytes ─> size ─> magic bytes ─> parse ─> pages
//
// Order matters as much as the checks do. Previously the 25MB limit was enforced AFTER
// `file.arrayBuffer()` had buffered the whole upload and unpdf had parsed it, so a 500MB
// file was fully read into a serverless function's memory and handed to the parser before
// anything objected — the limit protected storage, not the process.
//
// CSRF: the credential is the Supabase auth cookie (SameSite=Lax) and this route is
// POST-only, so a cross-site submission carries no session and 401s.

export const maxDuration = 60

const PDF_MAGIC = '%PDF-'

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

export async function POST(req: Request) {
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to upload a document.')

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
  if (file.type !== 'application/pdf') return bad(415, 'Only application/pdf is accepted.')
  // File.size is known without reading the body, so this catches a lying Content-Length.
  if (file.size > UPLOAD_LIMITS.maxFileSize)
    return bad(413, `File too large. Maximum ${UPLOAD_LIMITS.maxFileSize / 1024 / 1024}MB.`)
  if (file.size === 0) return bad(400, 'That file is empty.')

  const buffer = Buffer.from(await file.arrayBuffer())
  // Belt and braces: the two checks above are both self-reported by the client.
  if (buffer.length > UPLOAD_LIMITS.maxFileSize)
    return bad(413, `File too large. Maximum ${UPLOAD_LIMITS.maxFileSize / 1024 / 1024}MB.`)
  // Content sniffing, because a declared Content-Type is just a string the caller chose.
  if (buffer.subarray(0, 5).toString('latin1') !== PDF_MAGIC)
    return bad(415, 'That file is not a PDF.')

  const check = await inspectPdf(buffer)
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
  const storagePath = `${user.id}/${contentHash}.pdf`
  const { error: uploadError } = await admin.storage
    .from('documents')
    .upload(storagePath, buffer, { contentType: 'application/pdf', upsert: false })
  // The Supabase error text names the bucket and the storage backend. Keep it in the log.
  if (uploadError) {
    logger.error('pdf upload failed', { ownerId: user.id, reason: uploadError.message })
    return bad(502, 'Could not store the upload. Try again.')
  }

  // The object exists but nothing references it yet. If either row fails to write, remove
  // it — otherwise it is unreachable, uncountable and paid for indefinitely.
  try {
    const doc = await createDocument({
      ownerId: user.id,
      filename: file.name.slice(0, 255),
      sourceType: 'pdf',
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

/**
 * Parse far enough to know the file is a usable text PDF, and no further.
 *
 * Encrypted and image-only PDFs are rejected here rather than three stages later, because
 * "your scanned worksheet has no text layer" is only useful to a teacher at the moment
 * they upload it.
 */
async function inspectPdf(
  buffer: Buffer,
): Promise<{ ok: true; pageCount: number } | { ok: false; error: string }> {
  try {
    const { getDocumentProxy } = await import('unpdf')
    const doc = await getDocumentProxy(new Uint8Array(buffer))
    const pageCount = doc.numPages

    if (pageCount === 0) return { ok: false, error: 'That PDF has no pages.' }
    if (pageCount > UPLOAD_LIMITS.maxPages)
      return { ok: false, error: `Too many pages. Maximum ${UPLOAD_LIMITS.maxPages}.` }

    // Sample rather than scan: a text PDF shows a text layer within its first few pages,
    // and parsing 200 pages here would duplicate the extraction stage's work inside the
    // upload request.
    for (let i = 1; i <= Math.min(pageCount, 5); i++) {
      const content = await (await doc.getPage(i)).getTextContent()
      const hasText = content.items.some(
        (item) => 'str' in item && typeof item.str === 'string' && item.str.trim().length > 0,
      )
      if (hasText) return { ok: true, pageCount }
    }
    return {
      ok: false,
      error: 'That PDF has no selectable text. Scanned or image-only files are not supported yet.',
    }
  } catch (error) {
    // Covers encrypted files, truncated files and malformed xref tables alike: the parser
    // refused it, so we refuse it, without leaking parser internals to the caller.
    const message = error instanceof Error ? error.message : ''
    if (/password|encrypt/i.test(message))
      return { ok: false, error: 'That PDF is password-protected. Remove the password and try again.' }
    return { ok: false, error: 'That PDF could not be read. It may be corrupted.' }
  }
}
