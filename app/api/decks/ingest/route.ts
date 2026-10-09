import { NextResponse } from 'next/server'
import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { documents } from '@/lib/db/schema'
import { getAuthUser } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { AWAITING_UPLOAD, UPLOAD_LIMITS, UPLOAD_WINDOW_MS, UPLOADS_PER_HOUR, getDocumentByHash, reserveUpload, type Document } from '@/lib/documents'
import { acceptedLabels, formatForMime } from '@/lib/ingest/formats'
import { checkLimit, tooMany } from '@/lib/rate-limit'
import { getPlan } from '@/lib/usage'
import { PLAN_LIMITS } from '@/lib/plans'

// Issue an upload link for one source document (M7 ingestion; direct-to-storage since
// 2026-10-05). The file itself never passes through here:
//
//   browser: sha256(file) ──> POST here {filename, size, type, hash}
//                               ├─ owner already has this hash ──> { duplicate } (no upload)
//                               └─ reserve awaiting_upload row ──> { upload: signed URL }
//   browser: PUT file ──> Supabase Storage (owner/hash.ext, bucket caps 25MB + PDF/PPTX)
//   browser: POST /api/documents/{id}/confirm ──> byte checks, then background processing
//
// Why: Vercel refuses request bodies over 4.5MB (413 FUNCTION_PAYLOAD_TOO_LARGE), so a 25MB
// limit was a promise only localhost could keep. Everything here is checked on what the
// browser DECLARES, so it is only the cheap first gate; /confirm runs the real checks on the
// stored bytes and deletes anything that fails them.
//
// The signed upload passes migration 0011's RESTRICTIVE deny on client inserts into this
// bucket (verified against the hosted project 2026-10-05): the token authorizes exactly one
// path, chosen here from the owner and hash, and cannot overwrite an existing object.
//
// CSRF: the credential is the Supabase auth cookie (SameSite=Lax) and this route is
// POST-only, so a cross-site submission carries no session and 401s.

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

const HASH = /^[a-f0-9]{64}$/

function existingResponse(doc: Document) {
  return NextResponse.json({ documentId: doc.id, status: doc.status, pageCount: doc.pageCount, duplicate: true })
}

export async function POST(req: Request) {
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to upload a document.')

  const paced = await checkLimit('uploadPerUser', user.id)
  if (!paced.ok) return tooMany(paced.retryAfterSec)
  if (!PLAN_LIMITS[await getPlan(user.id)].documents)
    return bad(403, 'Uploading documents is not included in your plan.')

  let body: Record<string, unknown>
  try {
    const parsed: unknown = await req.json()
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    body = parsed as Record<string, unknown>
  } catch {
    return bad(400, 'Expected a JSON body.')
  }

  const format = typeof body.type === 'string' ? formatForMime(body.type) : undefined
  if (!format) return bad(415, `Only ${acceptedLabels()} uploads are accepted.`)
  const size = body.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return bad(400, 'That file is empty.')
  if (size > UPLOAD_LIMITS.maxFileSize)
    return bad(413, `File too large. Maximum ${UPLOAD_LIMITS.maxFileSize / 1024 / 1024}MB.`)
  const hash = body.hash
  if (typeof hash !== 'string' || !HASH.test(hash)) return bad(400, 'Missing file fingerprint.')
  // Shown back to the owner only; control characters would just garble that.
  const filename = (typeof body.filename === 'string' ? body.filename : '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255) || `upload.${format.extension}`

  // Same bytes from the same owner: hand back the document, no upload. A failed one comes
  // back too, and the browser retries it through /process as before.
  let doc = await getDocumentByHash(user.id, hash)
  if (doc && doc.status !== AWAITING_UPLOAD) return existingResponse(doc)

  if (!doc) {
    // Deleted and rejected uploads still count: both leave a tombstone inside this window.
    const now = Date.now()
    const [{ n, oldest }] = await db
      .select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${documents.createdAt})` })
      .from(documents)
      .where(and(eq(documents.ownerId, user.id), gt(documents.createdAt, new Date(now - UPLOAD_WINDOW_MS))))
    if (n >= UPLOADS_PER_HOUR) {
      // A slot frees when the oldest upload in the window ages out of it.
      const frees = oldest ? new Date(oldest).getTime() + UPLOAD_WINDOW_MS : now + UPLOAD_WINDOW_MS
      return tooMany(Math.max(1, Math.ceil((frees - now) / 1000)), `Upload limit reached (${UPLOADS_PER_HOUR}/hour). Try again later.`)
    }
    const reserved = await reserveUpload({
      ownerId: user.id,
      filename,
      sourceType: format.id,
      fileSize: size,
      contentHash: hash,
      storagePath: `${user.id}/${hash}.${format.extension}`,
    })
    doc = reserved.document
    // Lost a race to an identical drop that has already been confirmed.
    if (doc.status !== AWAITING_UPLOAD) return existingResponse(doc)
  }

  const bucket = createAdminClient().storage.from('documents')
  // An earlier link for this file was used but never confirmed (tab closed after the upload).
  // The bytes are there: confirm them instead of uploading again.
  const stored = await bucket.exists(doc.storagePath)
  if (stored.data === true) return NextResponse.json({ documentId: doc.id, status: AWAITING_UPLOAD, uploaded: true })

  const { data, error } = await bucket.createSignedUploadUrl(doc.storagePath)
  if (error || !data) {
    logger.error('document upload link failed', { documentId: doc.id, error })
    return bad(502, 'Could not start the upload. Try again.')
  }
  return NextResponse.json({ documentId: doc.id, status: AWAITING_UPLOAD, upload: { signedUrl: data.signedUrl } })
}
