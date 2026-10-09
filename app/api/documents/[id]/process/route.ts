import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/auth'
import {
  advanceDocument,
  documentCoverage,
  getDocument,
  getLatestJob,
  isStalled,
  ocrProgress,
  retryDocument,
  AWAITING_UPLOAD,
  DELETED,
  FAILED_STATES,
  MAX_INGESTION_ATTEMPTS,
  type IngestionState,
} from '@/lib/documents'
import { RESUME_AT, startIngestion } from '@/lib/ingestion'
import { checkLimit, tooMany } from '@/lib/rate-limit'
import { aiBudgetRefusal, refuse } from '@/lib/usage'

// Start (or resume) one document's background ingestion, and report where it is.
//
// Processing runs in the background now (startIngestion → next/server after(), up to
// RUN_BUDGET_MS inside a 300s invocation). It used to run inside this request while the page
// re-POSTed in a loop, so closing the tab stopped it. The browser only polls GET now.
//
//   POST  -> start or resume a run, return at once              { status, started }
//   GET   -> status, read-only; `stalled` when nobody holds it   { status, done, stalled, progress }
//
// A run already holding the lease makes a second POST a no-op (runIngestion reports paused
// and does nothing), so a double click or two tabs cost nothing.

export const maxDuration = 300 // RUN_MAX_DURATION_MS in lib/ingestion.ts; Next needs the literal here

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

// Stage failures reach the client as a fixed sentence keyed by the pipeline's own code,
// never as the stored `errorMessage`. That column holds the raw exception, which is the
// provider's or Supabase's text: a Gemini failure names the model, the billing tier and
// the numeric quota, and a storage failure names the bucket. It stays server-side, on the
// job row and in the log, where it is still there for debugging.
const FAILURE_MESSAGE: Record<string, string> = {
  EXTRACTION_FAILED: 'We could not read text from that file. If it is a scanned PDF, it needs a text layer.',
  OCR_FAILED: 'We could not read the images in that file. Try again.',
  STRUCTURE_DETECTION_FAILED: 'We could not work out the document structure. Try again.',
  NO_READABLE_TEXT: 'We found no readable text in that file, not even in its images. Try a version with real text, or a PDF.',
  AI_BUDGET_REACHED: "The slides are pictures, and this month's AI budget is used up, so they couldn't be read. Try again next month.",
  CHUNKING_FAILED: 'We could not split that document into passages. Try again.',
  EMBEDDING_FAILED: 'We could not index that document. Try again in a few minutes.',
  JOB_NOT_FOUND: 'No ingestion job for this document.',
  UNKNOWN_ERROR: 'Processing failed. Try again.',
}

function failureMessage(code: string | null | undefined): string | undefined {
  if (!code) return undefined
  return FAILURE_MESSAGE[code] ?? FAILURE_MESSAGE.UNKNOWN_ERROR
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to process a document.')
  const paced = await checkLimit('processPerUser', user.id)
  if (!paced.ok) return tooMany(paced.retryAfterSec)

  const doc = await getDocument(id, user.id)
  // Same 404 for missing and not-yours: never confirm another owner's document id exists.
  if (!doc || doc.status === DELETED) return bad(404, 'Document not found.')
  if (doc.status === 'ready')
    return NextResponse.json({ status: 'ready', done: true, coverage: await documentCoverage(id, user.id) })
  // Nothing to process until /confirm has checked the stored bytes.
  if (doc.status === AWAITING_UPLOAD) return bad(409, 'Finish uploading the file first.')

  // Processing spends money (structure detection, embeddings), so the global AI budget gates it
  // the same way it gates generation.
  const budget = await aiBudgetRefusal()
  if (budget) return refuse(budget)

  // A failed document needs an explicit new attempt, which bumps the job's attempt counter
  // so a retry loop is visible in the data rather than being indistinguishable from a
  // first run.
  const failed = FAILED_STATES.includes(doc.status as IngestionState)
  const job = failed ? await retryDocument(id, user.id) : await getLatestJob(id)
  if (!job)
    return bad(
      409,
      failed
        ? `This document failed ${MAX_INGESTION_ATTEMPTS} times. Delete it under Uploaded files on your dashboard, then upload it again.`
        : 'No ingestion job for this document.',
    )

  // Move a failed document onto the stage it resumes at BEFORE answering. Left to the
  // background run, the first status poll could still read failed_<stage> and the page
  // would show the retry as failed again before it had started.
  let status = doc.status as IngestionState
  const resumeAt = RESUME_AT[status]
  if (failed && resumeAt) {
    await advanceDocument(doc.id, status, resumeAt, job.id)
    status = resumeAt
  }
  startIngestion(job.id)
  return NextResponse.json({ status, started: true })
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to view a document.')

  const doc = await getDocument(id, user.id)
  if (!doc || doc.status === DELETED) return bad(404, 'Document not found.')

  const job = await getLatestJob(id)
  return NextResponse.json({
    status: doc.status,
    done: doc.status === 'ready',
    stalled: isStalled(doc),
    pageCount: doc.pageCount,
    attempt: job?.attempt ?? 0,
    error: failureMessage(job?.errorCode),
    progress: doc.status === 'ocr' ? await ocrProgress(id) : undefined,
    // Only once, at the end: mid-run the numbers are still moving, and a page the OCR stage
    // has not reached yet would be reported as unread when it is about to be rescued.
    coverage: doc.status === 'ready' ? await documentCoverage(id, user.id) : undefined,
  })
}
