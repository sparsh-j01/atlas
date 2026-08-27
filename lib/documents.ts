import 'server-only'

import { and, desc, eq, inArray } from 'drizzle-orm'
import { db } from './db'
import { documents, ingestionJobs, type Document, type IngestionJob } from './db/schema'

export type { Document, IngestionJob }

// Document + ingestion-job state. The state machine below is ENFORCED, not documented:
// every transition goes through advanceDocument, which writes conditionally on the
// expected current state. The previous version defined canTransition() and then never
// called it, moving every stage with an unconditional `updateDocumentStatusUnsafe` — so
// the machine was decoration and two concurrent workers could both run the same stage.

export const INGESTION_STATES = [
  'uploaded',
  'structuring',
  'chunking',
  'embedding',
  'ready',
  'failed_extraction',
  'failed_structuring',
  'failed_chunking',
  'failed_embedding',
] as const

export type IngestionState = (typeof INGESTION_STATES)[number]

export const FAILED_STATES: IngestionState[] = [
  'failed_extraction',
  'failed_structuring',
  'failed_chunking',
  'failed_embedding',
]

export const TERMINAL_STATES: IngestionState[] = ['ready', ...FAILED_STATES]

export function isIngestionState(v: unknown): v is IngestionState {
  return typeof v === 'string' && (INGESTION_STATES as readonly string[]).includes(v)
}

export async function createDocument(input: {
  ownerId: string
  filename: string
  sourceType: 'pdf' | 'pptx'
  fileSize: number
  pageCount: number
  contentHash: string
  storagePath: string
}): Promise<Document> {
  const [doc] = await db.insert(documents).values({ ...input, status: 'uploaded' }).returning()
  return doc
}

export async function getDocument(id: string, ownerId: string): Promise<Document | null> {
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
  return db.select().from(documents).where(eq(documents.ownerId, ownerId)).orderBy(desc(documents.createdAt))
}

export async function createIngestionJob(documentId: string): Promise<IngestionJob> {
  const [job] = await db.insert(ingestionJobs).values({ documentId, status: 'uploaded', attempt: 1 }).returning()
  return job
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

/** Record a stage failure on both rows. Unconditional on purpose — a failure must land
 *  whatever state the document was left in. */
export async function failDocument(
  id: string,
  state: IngestionState,
  jobId: string,
  errorCode: string,
  errorMessage: string,
): Promise<void> {
  await db.update(documents).set({ status: state, updatedAt: new Date() }).where(eq(documents.id, id))
  await db
    .update(ingestionJobs)
    .set({ status: state, errorCode, errorMessage: errorMessage.slice(0, 1000), finishedAt: new Date() })
    .where(eq(ingestionJobs.id, jobId))
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

/** Delete a document and everything derived from it.
 *
 *  Pages, sections, chunks, embeddings and citation rows all cascade from documents.id in
 *  the schema, so this is one delete plus the storage object — which does NOT cascade and
 *  is the thing that would otherwise be left paying for itself forever. */
export async function deleteDocument(
  id: string,
  ownerId: string,
  removeObject: (storagePath: string) => Promise<void>,
): Promise<boolean> {
  const doc = await getDocument(id, ownerId)
  if (!doc) return false
  await removeObject(doc.storagePath).catch(() => {
    // A missing object must not block the row delete; the row is the source of truth.
  })
  await db.delete(documents).where(and(eq(documents.id, id), eq(documents.ownerId, ownerId)))
  return true
}

/** Documents stuck mid-pipeline past `staleMs` — a driver that died between stages. */
export async function staleDocuments(staleMs: number): Promise<Document[]> {
  const cutoff = new Date(Date.now() - staleMs)
  const rows = await db
    .select()
    .from(documents)
    .where(inArray(documents.status, ['uploaded', 'structuring', 'chunking', 'embedding']))
  return rows.filter((d) => d.updatedAt < cutoff)
}

export const UPLOAD_LIMITS = {
  maxFileSize: 25 * 1024 * 1024, // 25MB
  maxPages: 200,
  allowedMimeTypes: ['application/pdf'] as const,
} as const
