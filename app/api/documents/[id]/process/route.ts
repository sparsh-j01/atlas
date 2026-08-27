import { NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/auth'
import {
  getDocument,
  getLatestJob,
  retryDocument,
  FAILED_STATES,
  MAX_INGESTION_ATTEMPTS,
  type IngestionState,
} from '@/lib/documents'
import { runIngestion } from '@/lib/ingestion'

// Drive one document's ingestion, and report where it got to.
//
// This route is the thing that was missing: lib/ingestion.ts had no caller anywhere in the
// repo, so an uploaded document stayed at `uploaded` forever and the PDF generation route
// rejected it for not being `ready`. The RAG path could not complete even once.
//
// A job model rather than a background worker, for the same reason M6 generation is a
// single request: Vercel functions do not outlive their response, so "fire and forget"
// silently forgets. The client POSTs, gets a status back, and POSTs again while
// `paused` is true — resumable because every stage's progress is committed to the
// document row before the next one starts.
//
//   POST  -> run stages until ready, failed, or out of budget   { status, done, paused }
//   GET   -> current status without doing any work              { status, done, paused }

export const maxDuration = 60
const TIME_BUDGET_MS = 50_000

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

// Stage failures reach the client as a fixed sentence keyed by the pipeline's own code,
// never as the stored `errorMessage`. That column holds the raw exception, which is the
// provider's or Supabase's text: a Gemini failure names the model, the billing tier and
// the numeric quota, and a storage failure names the bucket. It stays server-side, on the
// job row and in the log, where it is still there for debugging.
const FAILURE_MESSAGE: Record<string, string> = {
  EXTRACTION_FAILED: 'We could not read text from that PDF. If it is a scan, it needs a text layer.',
  STRUCTURE_DETECTION_FAILED: 'We could not work out the document structure. Try again.',
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

  const doc = await getDocument(id, user.id)
  // Same 404 for missing and not-yours: never confirm another owner's document id exists.
  if (!doc) return bad(404, 'Document not found.')
  if (doc.status === 'ready')
    return NextResponse.json({ status: 'ready', done: true, paused: false })

  // A failed document needs an explicit new attempt, which bumps the job's attempt counter
  // so a retry loop is visible in the data rather than being indistinguishable from a
  // first run.
  const failed = FAILED_STATES.includes(doc.status as IngestionState)
  const job = failed ? await retryDocument(id, user.id) : await getLatestJob(id)
  if (!job)
    return bad(
      409,
      failed
        ? `This document failed ${MAX_INGESTION_ATTEMPTS} times. Delete it and upload again.`
        : 'No ingestion job for this document.',
    )

  const outcome = await runIngestion(job.id, Date.now() + TIME_BUDGET_MS)
  const { errorCode, ...publicOutcome } = outcome
  // 200 even for a stage failure: the request succeeded, the ingestion did not, and the
  // body says which. A 5xx here would tell the client to retry the HTTP call, which is the
  // wrong remedy for "this PDF has no text layer".
  return NextResponse.json({ ...publicOutcome, error: failureMessage(errorCode) })
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to view a document.')

  const doc = await getDocument(id, user.id)
  if (!doc) return bad(404, 'Document not found.')

  const job = await getLatestJob(id)
  return NextResponse.json({
    status: doc.status,
    done: doc.status === 'ready',
    paused: false,
    pageCount: doc.pageCount,
    attempt: job?.attempt ?? 0,
    error: failureMessage(job?.errorCode),
  })
}
