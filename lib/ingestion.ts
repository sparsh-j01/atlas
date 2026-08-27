import 'server-only'

import { eq, sql } from 'drizzle-orm'
import { createAdminClient } from '@/lib/supabase/admin'
import { db } from '@/lib/db'
import {
  chunks,
  documentPages,
  documentSections,
  documents,
  embeddings,
  ingestionJobs,
  type Document,
  type IngestionJob,
} from '@/lib/db/schema'
import { advanceDocument, failDocument, type IngestionState } from '@/lib/documents'
import { chunkDocument, type IdentifiedSection } from '@/lib/ai/chunk'
import { detectSections, type SourcePage } from '@/lib/ai/structure'
import { embedBatch, embeddingConfig } from '@/lib/ai/embed'
import { geminiGenerate } from '@/lib/ai/gemini'
import { logger } from '@/lib/logger'

// Document ingestion pipeline (M7 phases 1-5).
//
//   uploaded ──> extracting ──> structuring ──> chunking ──> embedding ──> ready
//       │            │              │              │             │
//       └────────────┴──────────────┴──────────────┴─────────────┴──> failed_<stage>
//                                                                          │
//                                                        retry re-enters at that stage
//
// runIngestion() DRIVES the pipeline to completion instead of executing one stage and
// returning. The previous version advanced a single step per call and had no caller at
// all, so a document sat at `uploaded` forever while /api/decks/generate-pdf rejected it
// for not being `ready` — the whole RAG path was unreachable.
//
// Every stage is resumable: state lives in the document row, each stage reads what the
// previous one persisted, and re-entering a stage recomputes it. Running out of time
// budget is therefore an ordinary pause, not a loss.

const EXTRACTION_TIMEOUT_MS = 30_000
const STRUCTURE_TIMEOUT_MS = 60_000
// A stage is only STARTED with at least this much budget left; otherwise the run parks and
// the next call resumes. Better to stop cleanly between stages than to be killed mid-stage.
const MIN_STAGE_BUDGET_MS = 5_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

export interface IngestionOutcome {
  status: IngestionState
  /** True when the document reached `ready` (or was already there). */
  done: boolean
  /** True when the budget ran out mid-pipeline and another call should resume. */
  paused: boolean
  /** A stable code from FAILURE_OF, never the raw exception text. The underlying message
   *  can carry provider and storage detail (Gemini quota strings name the model, the tier
   *  and the rate limit; a Supabase error names the bucket), and this value is returned to
   *  the browser by /api/documents/{id}/process. The raw text is logged and stored on the
   *  job row instead, where only the server can read it. */
  errorCode?: string
}

type Job = { job: IngestionJob; document: Document }

async function loadJob(jobId: string): Promise<Job | null> {
  const [row] = await db
    .select({ job: ingestionJobs, document: documents })
    .from(ingestionJobs)
    .innerJoin(documents, eq(documents.id, ingestionJobs.documentId))
    .where(eq(ingestionJobs.id, jobId))
    .limit(1)
  return row ?? null
}

/** Join the persisted pages into the document text, recording each page's absolute offset
 *  so a chunk can be traced back to a page number. The separator must match what
 *  `fullText` used at chunking time or every offset shifts. */
const PAGE_SEPARATOR = '\n\n'

async function readPages(documentId: string): Promise<{ fullText: string; pages: SourcePage[] }> {
  const rows = await db
    .select({ pageNumber: documentPages.pageNumber, rawText: documentPages.rawText })
    .from(documentPages)
    .where(eq(documentPages.documentId, documentId))
    .orderBy(documentPages.pageNumber)

  const pages: SourcePage[] = []
  let offset = 0
  for (const r of rows) {
    pages.push({ pageNumber: r.pageNumber, text: r.rawText, offset })
    offset += r.rawText.length + PAGE_SEPARATOR.length
  }
  return { fullText: rows.map((r) => r.rawText).join(PAGE_SEPARATOR), pages }
}

// --- Stages ------------------------------------------------------------------

async function extract(doc: Document): Promise<void> {
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from('documents').download(doc.storagePath)
  if (error || !data) throw new Error(`download failed: ${error?.message ?? 'no data'}`)

  const buffer = Buffer.from(await data.arrayBuffer())
  const { extractText } = await import('unpdf')
  const { text, totalPages } = await withTimeout(
    extractText(new Uint8Array(buffer), { mergePages: false }),
    EXTRACTION_TIMEOUT_MS,
    'PDF text extraction',
  )

  await db.transaction(async (tx) => {
    // Re-entrant: a retry replaces what the previous attempt wrote rather than colliding
    // with the (document_id, page_number) unique index.
    await tx.delete(documentPages).where(eq(documentPages.documentId, doc.id))
    const rows = Array.from({ length: totalPages }, (_, i) => ({
      documentId: doc.id,
      pageNumber: i + 1,
      rawText: text[i] ?? '',
    }))
    if (rows.length > 0) await tx.insert(documentPages).values(rows)
    await tx.update(documents).set({ pageCount: totalPages, updatedAt: new Date() }).where(eq(documents.id, doc.id))
  })

  const extracted = text.join('').trim()
  if (extracted.length === 0)
    throw new Error('No extractable text. Image-only or scanned PDFs are not supported.')
}

async function structure(doc: Document, deadline: number): Promise<void> {
  const { fullText, pages } = await readPages(doc.id)
  if (pages.length === 0) throw new Error('no extracted pages to analyse')

  const sections = await detectSections(
    geminiGenerate(),
    fullText,
    pages,
    Math.min(deadline, Date.now() + STRUCTURE_TIMEOUT_MS),
  )
  if (sections.length === 0) throw new Error('no sections detected')

  await db.transaction(async (tx) => {
    await tx.delete(documentSections).where(eq(documentSections.documentId, doc.id))
    await tx.insert(documentSections).values(sections.map((s) => ({ documentId: doc.id, ...s })))
  })
}

async function chunk(doc: Document): Promise<void> {
  const { fullText } = await readPages(doc.id)
  const sections = await db
    .select()
    .from(documentSections)
    .where(eq(documentSections.documentId, doc.id))
    .orderBy(documentSections.startOffset)
  if (sections.length === 0) throw new Error('no sections to chunk')

  const identified: IdentifiedSection[] = sections.map((s) => ({
    id: s.id,
    heading: s.heading,
    pageStart: s.pageStart,
    pageEnd: s.pageEnd,
    startOffset: s.startOffset,
    endOffset: s.endOffset,
  }))
  const results = await chunkDocument(fullText, identified)
  if (results.length === 0) throw new Error('chunking produced nothing')

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(eq(chunks.documentId, doc.id))
    await tx.insert(chunks).values(
      results.map((c, i) => ({
        documentId: doc.id,
        sectionId: c.sectionId,
        chunkIndex: i,
        pageStart: c.pageStart,
        pageEnd: c.pageEnd,
        charStart: c.charStart,
        charEnd: c.charEnd,
        text: c.text,
        tokenCount: c.tokenCount,
        contentHash: c.contentHash,
      })),
    )
  })
}

async function embedAll(doc: Document): Promise<void> {
  const rows = await db
    .select({ id: chunks.id, text: chunks.text })
    .from(chunks)
    .where(eq(chunks.documentId, doc.id))
    .orderBy(chunks.chunkIndex)
  if (rows.length === 0) throw new Error('no chunks to embed')

  // One batched call per 100 chunks rather than one HTTP round trip per chunk, which
  // turned a 300-chunk PDF into 300 serial requests against a free-tier rate limit.
  const vectors = await embedBatch(
    rows.map((r) => r.text),
    'RETRIEVAL_DOCUMENT',
  )
  const cfg = embeddingConfig()

  // Re-embedding under the SAME provider/model/version recomputes the same answer, so
  // replace rather than collide with the unique index — that is what makes this stage
  // re-entrant after a partial failure. A new model version writes new rows instead and
  // leaves the previous population addressable, which is what re-embedding needs.
  await db
    .insert(embeddings)
    .values(
      rows.map((r, i) => ({
        chunkId: r.id,
        provider: cfg.provider,
        model: cfg.model,
        version: cfg.version,
        dimension: cfg.dimension,
        vector: vectors[i],
      })),
    )
    .onConflictDoUpdate({
      target: [embeddings.chunkId, embeddings.provider, embeddings.model, embeddings.version],
      set: { vector: sql`excluded.vector`, createdAt: new Date() },
    })
}

const STAGES: { from: IngestionState; to: IngestionState; run: (doc: Document, deadline: number) => Promise<void> }[] = [
  { from: 'uploaded', to: 'structuring', run: (doc) => extract(doc) },
  { from: 'structuring', to: 'chunking', run: (doc, d) => structure(doc, d) },
  { from: 'chunking', to: 'embedding', run: (doc) => chunk(doc) },
  { from: 'embedding', to: 'ready', run: (doc) => embedAll(doc) },
]

/** A failed state resumes at the stage that failed. */
const RESUME_AT: Partial<Record<IngestionState, IngestionState>> = {
  failed_extraction: 'uploaded',
  failed_structuring: 'structuring',
  failed_chunking: 'chunking',
  failed_embedding: 'embedding',
}

const FAILURE_OF: Record<string, { state: IngestionState; code: string }> = {
  uploaded: { state: 'failed_extraction', code: 'EXTRACTION_FAILED' },
  structuring: { state: 'failed_structuring', code: 'STRUCTURE_DETECTION_FAILED' },
  chunking: { state: 'failed_chunking', code: 'CHUNKING_FAILED' },
  embedding: { state: 'failed_embedding', code: 'EMBEDDING_FAILED' },
}

/**
 * Drive one document from wherever it is to `ready`, or to the failed state for the stage
 * that broke. Returns rather than throws: the caller is an HTTP route that needs to report
 * status, not a crash.
 */
export async function runIngestion(jobId: string, deadline: number): Promise<IngestionOutcome> {
  const loaded = await loadJob(jobId)
  if (!loaded) return { status: 'failed_extraction', done: false, paused: false, errorCode: 'JOB_NOT_FOUND' }

  const { job } = loaded
  let doc = loaded.document
  let state = (RESUME_AT[doc.status as IngestionState] ?? doc.status) as IngestionState

  if (doc.status === 'ready') return { status: 'ready', done: true, paused: false }

  while (state !== 'ready') {
    const stage = STAGES.find((s) => s.from === state)
    if (!stage) {
      // An internal invariant, not a user-actionable failure: the state name is a detail of
      // the pipeline, so it goes to the log rather than into the response.
      logger.error('ingestion reached a state with no stage', { documentId: doc.id, jobId: job.id, state })
      return { status: state, done: false, paused: false, errorCode: 'UNKNOWN_ERROR' }
    }

    if (deadline - Date.now() < MIN_STAGE_BUDGET_MS)
      return { status: state, done: false, paused: true }

    const startedAt = Date.now()
    try {
      await stage.run(doc, deadline)
      // Conditional on the state we started from, so this doubles as the stage lock: if a
      // concurrent driver already advanced past it, no row comes back and we stop rather
      // than marching a document through a stage twice. Every stage deletes what it is
      // about to write first, so the losing worker leaves nothing behind.
      doc = await advanceDocument(doc.id, state, stage.to, job.id)
      // One structured line per stage, to stdout, which is what Vercel actually captures.
      // The replaced observability module accumulated traces in a module-level Map — in a
      // serverless runtime that is a per-invocation object nobody can ever read back.
      logger.info('ingestion stage complete', {
        documentId: doc.id,
        jobId: job.id,
        stage: state,
        next: stage.to,
        durationMs: Date.now() - startedAt,
      })
      state = stage.to
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const failure = FAILURE_OF[state] ?? { state: 'failed_extraction' as IngestionState, code: 'UNKNOWN_ERROR' }
      logger.error('ingestion stage failed', {
        documentId: doc.id,
        jobId: job.id,
        stage: state,
        code: failure.code,
        durationMs: Date.now() - startedAt,
        message,
      })
      await failDocument(doc.id, failure.state, job.id, failure.code, message)
      return { status: failure.state, done: false, paused: false, errorCode: failure.code }
    }
  }

  return { status: 'ready', done: true, paused: false }
}
