import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/auth'
import { createAdminClient } from '@/lib/supabase/admin'
import { logger } from '@/lib/logger'
import { AWAITING_UPLOAD, DELETED, UPLOAD_LIMITS, deleteDocument, getDocument, markUploaded } from '@/lib/documents'
import { checkUploadedBytes } from '@/lib/ingest/check-upload'
import { formatForId } from '@/lib/ingest/formats'
import { startIngestion } from '@/lib/ingestion'
import { checkLimit, tooMany } from '@/lib/rate-limit'
import { documentStoragePath } from '@/lib/storage-path'
import { aiBudgetRefusal } from '@/lib/usage'

// The browser has put the file in Storage (see app/api/decks/ingest). Check the stored bytes,
// then start background processing.
//
//   awaiting_upload ──checks pass──> uploaded ──> startIngestion (after(), RUN_BUDGET_MS)
//          │
//          └──checks fail──> object removed, row tombstoned (still counts toward the hourly cap)
//
// Safe to repeat: the browser retries when a response is lost, and a second tab may confirm
// the same file. Only the call that moves the row out of awaiting_upload creates a job and
// starts a run (markUploaded is conditional on the status); any other call reports where the
// document is now.

export const maxDuration = 300 // RUN_MAX_DURATION_MS in lib/ingestion.ts; Next needs the literal here

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to upload a document.')
  const paced = await checkLimit('processPerUser', user.id)
  if (!paced.ok) return tooMany(paced.retryAfterSec)

  const doc = await getDocument(id, user.id)
  // Same 404 for missing and not-yours: never confirm another owner's document id exists.
  if (!doc || doc.status === DELETED) return bad(404, 'Document not found.')
  if (doc.status !== AWAITING_UPLOAD) return NextResponse.json({ status: doc.status, pageCount: doc.pageCount })

  const format = formatForId(doc.sourceType)
  const path = documentStoragePath(doc)
  if (!format || !path) return bad(404, 'Document not found.')

  const { data, error } = await createAdminClient().storage.from('documents').download(path)
  // Not there yet, or Storage is down. Either way the reservation stays, so a retry (or a
  // re-drop, which reissues the link) can finish it; the reaper clears it after a day.
  if (error || !data) return bad(409, 'The upload has not finished. Try again.')
  const buffer = Buffer.from(await data.arrayBuffer())

  const check = await checkUploadedBytes(buffer, format, doc.contentHash, UPLOAD_LIMITS)
  if (!check.ok) {
    logger.warn('document upload rejected', { documentId: doc.id, status: check.status })
    try {
      // Removes the object and leaves a tombstone, so junk uploads keep counting toward
      // UPLOADS_PER_HOUR instead of freeing their slot on rejection.
      await deleteDocument(doc.id, user.id)
    } catch (cleanupError) {
      logger.error('document upload cleanup failed', { documentId: doc.id, error: cleanupError })
    }
    return bad(check.status, check.error)
  }

  const job = await markUploaded(doc.id, user.id, { pageCount: check.pageCount, fileSize: buffer.length })
  if (!job) {
    const now = await getDocument(id, user.id)
    return NextResponse.json({ status: now?.status ?? DELETED, pageCount: now?.pageCount ?? 0 })
  }

  // Processing spends money, so the global AI budget gates starting it. Refused, the file is
  // still safely uploaded: it shows as stalled and a Resume next month (or after a raised
  // cap) picks it up.
  const budget = await aiBudgetRefusal()
  if (budget) return NextResponse.json({ status: 'uploaded', pageCount: check.pageCount, error: budget.error })

  startIngestion(job.id, buffer)
  return NextResponse.json({ status: 'uploaded', pageCount: check.pageCount, started: true })
}
