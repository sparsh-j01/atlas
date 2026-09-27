import 'server-only'

import { and, desc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm'
import { db } from './db'
import { isUuid } from './ids'
import { documentStoragePath } from './storage-path'
import { createAdminClient } from './supabase/admin'
import { documentAssets, documentPages, documents, ingestionJobs, type Document, type IngestionJob } from './db/schema'
import { buildCoverageReport, type CoverageReport, type UnreadPage } from './ingest/coverage'
import { ACCEPTED_MIME_TYPES } from './ingest/formats'

export type { Document, IngestionJob }

// Document + ingestion-job state. The state machine below is ENFORCED, not documented:
// every transition goes through advanceDocument, which writes conditionally on the
// expected current state. The previous version defined canTransition() and then never
// called it, moving every stage with an unconditional `updateDocumentStatusUnsafe` — so
// the machine was decoration and two concurrent workers could both run the same stage.

export const INGESTION_STATES = [
  'uploaded',
  // Text recovery from embedded images. A no-op for documents whose pages already carry
  // text, which is every PDF today — the stage runs, finds nothing text-poor, and advances.
  'ocr',
  'structuring',
  'chunking',
  'embedding',
  'ready',
  'failed_extraction',
  'failed_ocr',
  'failed_structuring',
  'failed_chunking',
  'failed_embedding',
] as const

export type IngestionState = (typeof INGESTION_STATES)[number]

export const FAILED_STATES: IngestionState[] = [
  'failed_extraction',
  'failed_ocr',
  'failed_structuring',
  'failed_chunking',
  'failed_embedding',
]

export const TERMINAL_STATES: IngestionState[] = ['ready', ...FAILED_STATES]

/** A row reserved by the upload-link route before the browser sends a byte. Not an
 *  IngestionState: nothing exists to ingest until /confirm checks the stored bytes.
 *
 *  The row exists before the upload so the two things that can only see rows see it too: the
 *  hourly upload count (a link that is fetched and never confirmed still costs a slot) and the
 *  daily reaper (an abandoned upload is deleted with its object after STALE_AFTER_MS). */
export const AWAITING_UPLOAD = 'awaiting_upload'

/**
 * Reserve the row for an upload of `contentHash`, or return the live document that already
 * has it.
 *
 * ON CONFLICT against documents_owner_hash_live_idx is what makes "already uploaded?" and
 * "create it" one step. As a lookup followed by an insert, two drops of the same file both
 * missed the lookup and both inserted, so two rows shared one storage object and deleting
 * either removed the other's file.
 */
export async function reserveUpload(input: {
  ownerId: string
  filename: string
  sourceType: 'pdf' | 'pptx'
  fileSize: number
  contentHash: string
  storagePath: string
}): Promise<{ document: Document; created: boolean }> {
  const [created] = await db
    .insert(documents)
    .values({ ...input, pageCount: 0, status: AWAITING_UPLOAD })
    .onConflictDoNothing({ target: [documents.ownerId, documents.contentHash], where: sql`${documents.contentHash} <> ''` })
    .returning()
  if (created) return { document: created, created: true }
  const existing = await getDocumentByHash(input.ownerId, input.contentHash)
  if (!existing) throw new Error('upload reservation conflicted with a row that is gone')
  return { document: existing, created: false }
}

/**
 * awaiting_upload → uploaded, with its first ingestion job, exactly once.
 *
 * Conditional on the status, so a confirm that is retried (the response was lost) or raced
 * (two tabs) creates no second job: the loser gets null and reports the current state. The
 * file must never have an `uploaded` row without its job, hence one transaction.
 */
export async function markUploaded(
  id: string,
  ownerId: string,
  checked: { pageCount: number; fileSize: number },
): Promise<IngestionJob | null> {
  return db.transaction(async (tx) => {
    const [doc] = await tx
      .update(documents)
      .set({ ...checked, status: 'uploaded', updatedAt: new Date() })
      .where(and(eq(documents.id, id), eq(documents.ownerId, ownerId), eq(documents.status, AWAITING_UPLOAD)))
      .returning({ id: documents.id })
    if (!doc) return null
    const [job] = await tx.insert(ingestionJobs).values({ documentId: id, status: 'uploaded', attempt: 1 }).returning()
    return job
  })
}

export async function getDocument(id: string, ownerId: string): Promise<Document | null> {
  if (!isUuid(id)) return null
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.id, id), eq(documents.ownerId, ownerId)))
    .limit(1)
  return doc ?? null
}

export async function getDocumentByHash(ownerId: string, contentHash: string): Promise<Document | null> {
  const [doc] = await db
    .select()
    .from(documents)
    .where(and(eq(documents.ownerId, ownerId), eq(documents.contentHash, contentHash)))
    .limit(1)
  return doc ?? null
}

export async function listDocuments(ownerId: string): Promise<Document[]> {
  return db
    .select()
    .from(documents)
    .where(and(eq(documents.ownerId, ownerId), ne(documents.status, DELETED)))
    .orderBy(desc(documents.createdAt))
}

export async function getLatestJob(documentId: string): Promise<IngestionJob | null> {
  const [job] = await db
    .select()
    .from(ingestionJobs)
    .where(eq(ingestionJobs.documentId, documentId))
    .orderBy(desc(ingestionJobs.attempt))
    .limit(1)
  return job ?? null
}

/**
 * Claim a document for one ingestion run, until `until`; null when another run holds it.
 *
 * Security review F06: concurrent Process requests each ran the current billable stage and
 * only the state transition AFTER it picked a winner, so N clicks paid for N runs. Claimed
 * here, before any stage, in one conditional UPDATE. `until` must outlast the request's
 * own life (maxDuration), so a run can't still be writing after its lease lapses; a run
 * killed mid-way just lets the lease expire. App clock on both sides, never mixed with now().
 */
export async function claimDocument(id: string, until: Date): Promise<Date | null> {
  const [row] = await db
    .update(documents)
    .set({ leaseUntil: until })
    .where(and(eq(documents.id, id), or(isNull(documents.leaseUntil), lt(documents.leaseUntil, new Date()))))
    .returning({ id: documents.id })
  return row ? until : null
}

/** Give a claim back early. Matches only our own `until`, so a lapsed lease someone else
 *  has since taken is left alone. */
export async function releaseDocument(id: string, until: Date): Promise<void> {
  await db
    .update(documents)
    .set({ leaseUntil: null })
    .where(and(eq(documents.id, id), eq(documents.leaseUntil, until)))
}

/**
 * Move a document from `expected` to `next`, and mirror it onto the job row.
 *
 * The WHERE clause pins the current status, so this is also the stage lock: if another
 * worker already advanced past `expected`, no row comes back and the caller throws rather
 * than redoing work someone else is doing.
 */
export async function advanceDocument(
  id: string,
  expected: IngestionState,
  next: IngestionState,
  jobId: string,
): Promise<Document> {
  const [doc] = await db
    .update(documents)
    .set({ status: next, updatedAt: new Date() })
    .where(and(eq(documents.id, id), eq(documents.status, expected)))
    .returning()
  if (!doc) throw new Error(`document ${id} is no longer in state "${expected}"`)

  await db
    .update(ingestionJobs)
    .set({ status: next, finishedAt: TERMINAL_STATES.includes(next) ? new Date() : null })
    .where(eq(ingestionJobs.id, jobId))
  return doc
}

/** Record a stage failure on both rows — but only if the document is still in the stage
 *  that failed. Returns false when it is not, which means another driver moved it on (two
 *  tabs processing the same upload, which the content-hash dedupe makes easy) or it was
 *  deleted.
 *
 *  This used to be unconditional, "so a failure must land whatever state the document was
 *  left in". The stage lock is only taken at the END of a stage (advanceDocument), so with
 *  two drivers the loser always reached this — its insert hit the winner's rows, or its
 *  advance found the status already moved — and stamped `failed_<stage>` over the winner's
 *  progress, every time, burning one of MAX_INGESTION_ATTEMPTS.
 *
 *  ponytail: this stops a loser overwriting the STATUS. Two drivers can still interleave
 *  inside a stage (the loser re-chunking under the winner's embedding run); that ends in a
 *  real failure the retry repairs. Upgrade path: claim the stage at its start, not its end. */
export async function failDocument(
  id: string,
  expected: IngestionState,
  state: IngestionState,
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<boolean> {
  const [doc] = await db
    .update(documents)
    .set({ status: state, updatedAt: new Date() })
    .where(and(eq(documents.id, id), eq(documents.status, expected)))
    .returning({ id: documents.id })
  if (!doc) return false
  await db
    .update(ingestionJobs)
    .set({ status: state, errorCode, errorMessage: errorMessage.slice(0, 1000), finishedAt: new Date() })
    .where(eq(ingestionJobs.id, jobId))
  return true
}

/** Start a fresh attempt after a failure. Returns null if the document is not in a failed
 *  state, so a retry cannot restart a run that is still in flight. */
/** A document that has failed this many times is not going to succeed on the next identical
 *  attempt, and each retry re-runs real provider calls: structure detection is one Gemini
 *  call per 40k-char window and embedding re-embeds every chunk. Without a ceiling, POSTing
 *  /api/documents/{id}/process in a loop is an unmetered way for one account to spend the
 *  project's whole Gemini quota. */
export const MAX_INGESTION_ATTEMPTS = 5

export async function retryDocument(id: string, ownerId: string): Promise<IngestionJob | null> {
  const doc = await getDocument(id, ownerId)
  if (!doc || !FAILED_STATES.includes(doc.status as IngestionState)) return null

  const previous = await getLatestJob(id)
  const attempt = (previous?.attempt ?? 0) + 1
  if (attempt > MAX_INGESTION_ATTEMPTS) return null

  const [job] = await db
    .insert(ingestionJobs)
    .values({ documentId: id, status: doc.status, attempt })
    .returning()
  return job
}

/** The upload quota's window (`app/api/decks/ingest`). Exported because deleting a document
 *  has to keep it counted inside this window — see `deleteDocument`. */
export const UPLOAD_WINDOW_MS = 60 * 60 * 1000

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
export const UPLOADS_PER_HOUR = 20

/** Uploads this owner has made inside the quota window, deleted ones included. */
export async function recentUploadCount(ownerId: string, now = Date.now()): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.ownerId, ownerId), gt(documents.createdAt, new Date(now - UPLOAD_WINDOW_MS))))
  return row?.n ?? 0
}

/** Status of a tombstone row. Not an ingestion state: nothing ever advances to or from it. */
export const DELETED = 'deleted'

/** Remove an upload from the private `documents` bucket. Throws on failure — the caller must
 *  not report a file as deleted while it is still stored. */
export async function removeStoredObject(storagePath: string): Promise<void> {
  const { error } = await createAdminClient().storage.from('documents').remove([storagePath])
  if (error) throw new Error('Storage removal failed') // provider text stays out of logs (F05)
}

/** Delete a document and everything derived from it.
 *
 *  Storage goes first, and a storage failure stops the delete: the row is the only pointer to
 *  the object, so dropping the row after a failed remove would leave the teacher's file stored
 *  forever with nothing left to find it by — while the UI told them it was gone.
 *
 *  Pages, sections, chunks, embeddings, jobs and citation rows all cascade from documents.id,
 *  so the row delete takes them with it.
 *
 *  A document uploaded inside the quota window leaves a TOMBSTONE: an empty row with the same
 *  owner and created_at. The upload quota counts rows by created_at, so without it
 *  upload → process → delete → repeat would reset the count every time and buy unlimited
 *  Gemini calls — exactly what UPLOADS_PER_HOUR exists to stop. The tombstone carries no
 *  filename, hash or path, its id is never handed out, and `reapDocuments` purges it once the
 *  window has passed. */
export async function deleteDocument(
  id: string,
  ownerId: string,
  removeObject: (storagePath: string) => Promise<void> = removeStoredObject,
): Promise<boolean> {
  const doc = await getDocument(id, ownerId)
  if (!doc || doc.status === DELETED) return false
  // A path that isn't this row's own (see storage-path.ts) is never handed to the service
  // role; the row is still deleted. The eval corpus's `eval://` rows land here too: no object.
  const path = documentStoragePath(doc)
  if (path) await removeObject(path)

  await db.transaction(async (tx) => {
    const [gone] = await tx
      .delete(documents)
      .where(and(eq(documents.id, id), eq(documents.ownerId, ownerId)))
      .returning({ createdAt: documents.createdAt, sourceType: documents.sourceType })
    if (!gone || gone.createdAt.getTime() <= Date.now() - UPLOAD_WINDOW_MS) return
    await tx.insert(documents).values({
      ownerId,
      filename: '',
      sourceType: gone.sourceType,
      status: DELETED,
      fileSize: 0,
      pageCount: 0,
      contentHash: '',
      storagePath: '',
      createdAt: gone.createdAt,
    })
  })
  return true
}

const RUNNING_STATES = ['uploaded', 'ocr', 'structuring', 'chunking', 'embedding']
/** No worker for this long counts as stalled. A run claims its lease within a second of being
 *  started, and holds it until it ends, so 30s idle with no live lease means nobody is coming. */
export const STALL_AFTER_MS = 30_000

/** Mid-pipeline, no live lease, and idle: the background run paused on its budget or died.
 *  GET /process reports it and the page or dashboard sends one explicit Resume. */
export function isStalled(doc: Pick<Document, 'status' | 'leaseUntil' | 'updatedAt'>, now = Date.now()): boolean {
  if (!RUNNING_STATES.includes(doc.status)) return false
  if (doc.leaseUntil && doc.leaseUntil.getTime() > now) return false
  return now - doc.updatedAt.getTime() > STALL_AFTER_MS
}

/** Images the ocr stage has finished, of all it recorded: "Reading slide images 15/25". */
export async function ocrProgress(documentId: string): Promise<{ done: number; total: number }> {
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      done: sql<number>`(count(*) filter (where ${documentAssets.ocrStatus} <> 'pending'))::int`,
    })
    .from(documentAssets)
    .where(eq(documentAssets.documentId, documentId))
  return { done: row?.done ?? 0, total: row?.total ?? 0 }
}

/** Documents stuck mid-pipeline past `staleMs` (a driver that died between stages), or
 *  reserved for an upload that was never confirmed. */
export async function staleDocuments(staleMs: number): Promise<Document[]> {
  return db
    .select()
    .from(documents)
    .where(
      and(
        inArray(documents.status, [AWAITING_UPLOAD, ...RUNNING_STATES]),
        lt(documents.updatedAt, new Date(Date.now() - staleMs)),
      ),
    )
}

/** How long an unfinished upload may sit untouched before it counts as abandoned.
 *
 *  A background run lasts at most one 300s invocation and a stalled one is resumed from the
 *  page or the dashboard, so nothing really being processed sits untouched for long. A day is
 *  far past that, and a teacher who comes back later just re-uploads, which costs the same.
 *  An upload link that was never used (AWAITING_UPLOAD) is abandoned on the same clock. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000

/** The cleanup pass behind `/api/cron/daily`: delete abandoned uploads, then purge
 *  tombstones older than the quota window.
 *
 *  ponytail: one document at a time, no batch cap. If the function is killed mid-loop nothing
 *  is lost — every delete is independent and the next run picks up the rest. A document whose
 *  storage remove fails is skipped and counted, and retried the next day. */
export async function reapDocuments(
  removeObject: (storagePath: string) => Promise<void> = removeStoredObject,
): Promise<{ reaped: number; failed: number; tombstones: number }> {
  let reaped = 0
  let failed = 0
  for (const doc of await staleDocuments(STALE_AFTER_MS)) {
    try {
      if (await deleteDocument(doc.id, doc.ownerId, removeObject)) reaped++
    } catch {
      failed++
    }
  }
  const purged = await db
    .delete(documents)
    .where(and(eq(documents.status, DELETED), lt(documents.createdAt, new Date(Date.now() - UPLOAD_WINDOW_MS))))
    .returning({ id: documents.id })
  return { reaped, failed, tombstones: purged.length }
}

/**
 * Which pages of a document produced no text, and why.
 *
 * Read from `unread_reason`, which extraction writes and the OCR stage clears for any page
 * it rescues. Surfacing this is the whole reason the column exists: a teacher whose deck is
 * half screenshots would otherwise see a clean "ready" and questions drawn from half the
 * material, with nothing anywhere to say so.
 */
export async function documentCoverage(documentId: string, ownerId: string): Promise<CoverageReport> {
  const rows = await db
    .select({ pageNumber: documentPages.pageNumber, unreadReason: documentPages.unreadReason, sourceType: documents.sourceType })
    .from(documentPages)
    // Joined to the owner rather than trusting the caller to have checked, which is what
    // every other accessor here does (getDocument, getDocumentByHash, deleteDocument). Both
    // current callers DO check first, so this closes nothing that is open today — it stops
    // the next caller from being the one that forgets, on a function whose only argument
    // was an id the client supplies.
    .innerJoin(documents, eq(documents.id, documentPages.documentId))
    .where(and(eq(documentPages.documentId, documentId), eq(documents.ownerId, ownerId)))
    .orderBy(documentPages.pageNumber)

  const unread = rows
    .filter((r) => r.unreadReason)
    .map((r) => ({ pageNumber: r.pageNumber, reason: r.unreadReason }) as UnreadPage)
  return buildCoverageReport(rows.length, unread, rows[0]?.sourceType === 'pdf' ? 'page' : 'slide')
}

export const UPLOAD_LIMITS = {
  maxFileSize: 25 * 1024 * 1024, // 25MB
  maxPages: 200,
  // Read from the format registry rather than restated here. The previous literal was dead
  // — nothing in the repo read it — so it still said PDF-only long after that stopped being
  // the whole story, which is exactly how an allowlist drifts out of sync with the bucket.
  allowedMimeTypes: ACCEPTED_MIME_TYPES,
} as const
