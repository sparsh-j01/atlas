import 'server-only'

import { and, eq, sql } from 'drizzle-orm'
import { createAdminClient } from '@/lib/supabase/admin'
import { db } from '@/lib/db'
import {
  chunks,
  documentAssets,
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
import { extractPptx } from '@/lib/ingest/pptx'
import { deriveSlideSections } from '@/lib/ingest/sections'
import { isTextPoor } from '@/lib/ingest/coverage'
import { canOcr, createTesseractEngine, isUsableOcrText, type OcrEngine } from '@/lib/ingest/ocr'
import { readZipEntries } from '@/lib/ingest/zip'

// Document ingestion pipeline (M7 phases 1-5, extended for PPTX + OCR in M7.5).
//
// The state names below are the ones in INGESTION_STATES; a document's status column IS
// the stage it is about to run.
//
//   uploaded ──> ocr ──> structuring ──> chunking ──> embedding ──> ready
//       │         │           │             │             │
//       └─────────┴───────────┴─────────────┴─────────────┴──> failed_<stage>
//                                                                    │
//                                                  retry re-enters at that stage
//
// Two formats share every stage after extraction:
//
//   PDF   unpdf text layer ──┐
//                            ├──> document_pages ──> ocr ──> sections ──> chunks ──> vectors
//   PPTX  slide XML ─────────┘
//
// One slide is one page, so `document_pages` carries both without a second document model,
// and chunking, embedding and retrieval never learn a format exists. Where they DO differ:
// PDF asks Gemini where its sections are, PPTX derives them from slide boundaries, and
// only PPTX has embedded images for the ocr stage to read.
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
// One image is only STARTED with this much budget left. Recognition runs 1-3s for a slide
// screenshot, so this leaves room to finish it and commit before the function is killed.
const OCR_IMAGE_BUDGET_MS = 12_000
const OCR_IMAGE_TIMEOUT_MS = 20_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}

/** What a stage reports back. `done: false` means it ran out of budget partway and
 *  committed what it finished — the driver parks WITHOUT advancing, and the next call
 *  re-enters the same stage to pick up the rest. Returning nothing means "finished",
 *  which is what every stage that cannot park does. */
type StageResult = { done: boolean } | void

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

/** Digital text first, then anything OCR recovered from that page's images.
 *
 *  When `ocr_text` is NULL — which is every page of every PDF — this returns exactly what
 *  the PDF-only version returned, byte for byte, including the offsets. That is the
 *  property the whole PDF regression rests on, and it is asserted directly in the tests. */
export function pageText(rawText: string, ocrText: string | null): string {
  if (!ocrText) return rawText
  return rawText.trim().length > 0 ? `${rawText}\n${ocrText}` : ocrText
}

async function readPages(documentId: string): Promise<{ fullText: string; pages: SourcePage[] }> {
  const rows = await db
    .select({
      pageNumber: documentPages.pageNumber,
      rawText: documentPages.rawText,
      ocrText: documentPages.ocrText,
    })
    .from(documentPages)
    .where(eq(documentPages.documentId, documentId))
    .orderBy(documentPages.pageNumber)

  const pages: SourcePage[] = []
  let offset = 0
  for (const r of rows) {
    const text = pageText(r.rawText, r.ocrText)
    pages.push({ pageNumber: r.pageNumber, text, offset })
    offset += text.length + PAGE_SEPARATOR.length
  }
  return { fullText: pages.map((p) => p.text).join(PAGE_SEPARATOR), pages }
}

// --- Stages ------------------------------------------------------------------

/** The stored source bytes. Every stage that needs the original file goes through here. */
async function download(doc: Document): Promise<Buffer> {
  const admin = createAdminClient()
  const { data, error } = await admin.storage.from('documents').download(doc.storagePath)
  if (error || !data) throw new Error(`download failed: ${error?.message ?? 'no data'}`)
  return Buffer.from(await data.arrayBuffer())
}

/** What extraction produced, before it is written. Assets are PPTX-only and stay empty for
 *  a PDF, which is what makes the PDF path through this function byte-identical. */
interface ExtractedPages {
  pages: { pageNumber: number; rawText: string; unreadReason?: string }[]
  assets: { pageNumber: number; assetIndex: number; entryPath: string; mimeType: string }[]
}

async function extractPdf(buffer: Buffer): Promise<ExtractedPages> {
  const { extractText } = await import('unpdf')
  const { text, totalPages } = await withTimeout(
    extractText(new Uint8Array(buffer), { mergePages: false }),
    EXTRACTION_TIMEOUT_MS,
    'PDF text extraction',
  )

  return {
    pages: Array.from({ length: totalPages }, (_, i) => ({
      pageNumber: i + 1,
      rawText: text[i] ?? '',
    })),
    assets: [],
  }
}

function extractPptxPages(buffer: Buffer): ExtractedPages {
  const { pages, assets } = extractPptx(new Uint8Array(buffer))
  return {
    pages: pages.map((p) => ({
      pageNumber: p.pageNumber,
      rawText: p.text,
      unreadReason: p.unreadReason,
    })),
    assets,
  }
}

async function extract(doc: Document): Promise<void> {
  const buffer = await download(doc)
  const extracted =
    doc.sourceType === 'pptx' ? extractPptxPages(buffer) : await extractPdf(buffer)

  await db.transaction(async (tx) => {
    // Re-entrant: a retry replaces what the previous attempt wrote rather than colliding
    // with the (document_id, page_number) unique index.
    await tx.delete(documentPages).where(eq(documentPages.documentId, doc.id))
    await tx.delete(documentAssets).where(eq(documentAssets.documentId, doc.id))
    if (extracted.pages.length > 0)
      await tx.insert(documentPages).values(
        extracted.pages.map((p) => ({
          documentId: doc.id,
          pageNumber: p.pageNumber,
          rawText: p.rawText,
          unreadReason: p.unreadReason ?? null,
        })),
      )
    if (extracted.assets.length > 0)
      await tx.insert(documentAssets).values(
        extracted.assets.map((a) => ({ documentId: doc.id, ...a })),
      )
    await tx
      .update(documents)
      .set({ pageCount: extracted.pages.length, updatedAt: new Date() })
      .where(eq(documents.id, doc.id))
  })

  // PDF only, and AFTER the write — which is the order the PDF-only pipeline used, so a
  // failed image-only PDF still leaves the same rows behind as it always did.
  //
  // Image-only PDFs are still rejected rather than sent to OCR: recovering them needs a
  // page rasterizer this project does not have. A PPTX reaching the same condition is NOT
  // rejected, because its images are already image files and the ocr stage can read them.
  if (doc.sourceType !== 'pptx' && extracted.pages.every((p) => p.rawText.trim().length === 0))
    throw new Error('No extractable text. Image-only or scanned PDFs are not supported.')
}

/**
 * Recover text from embedded images, for the pages that need it.
 *
 * Budget-aware and resumable at the level of a single image: each recognised image is
 * committed on its own, so running out of time is a pause rather than a loss, and the next
 * call skips everything already marked done. A 40-slide deck at 1-3 seconds an image does
 * not fit in one 60-second invocation, which is why this stage can park mid-way and the
 * others cannot.
 *
 * A no-op for every PDF: nothing is text-poor because nothing has assets, so the loop
 * finds no work and the stage advances immediately.
 */
async function ocrPass(doc: Document, deadline: number): Promise<StageResult> {
  const pending = await db
    .select()
    .from(documentAssets)
    .where(and(eq(documentAssets.documentId, doc.id), eq(documentAssets.ocrStatus, 'pending')))
    .orderBy(documentAssets.pageNumber, documentAssets.assetIndex)
  if (pending.length === 0) return { done: true }

  // Only images on pages that are actually short of text. A slide with a full paragraph
  // and a decorative logo does not need its logo read.
  const pages = await db
    .select({ pageNumber: documentPages.pageNumber, rawText: documentPages.rawText })
    .from(documentPages)
    .where(eq(documentPages.documentId, doc.id))
  const textByPage = new Map(pages.map((p) => [p.pageNumber, p.rawText]))
  const assetsByPage = new Map<number, number>()
  for (const a of pending) assetsByPage.set(a.pageNumber, (assetsByPage.get(a.pageNumber) ?? 0) + 1)

  const wanted = pending.filter((a) =>
    isTextPoor(textByPage.get(a.pageNumber) ?? '', assetsByPage.get(a.pageNumber) ?? 0),
  )

  // Everything else is deliberately not-OCR'd, and says so rather than staying `pending`
  // forever and re-querying on every resume.
  const skipped = pending.filter((a) => !wanted.includes(a))
  for (const a of skipped) await setAssetOcr(a.id, 'skipped', null)
  if (wanted.length === 0) return { done: true }

  const readable = wanted.filter((a) => canOcr(a.mimeType))
  for (const a of wanted) if (!canOcr(a.mimeType)) await setAssetOcr(a.id, 'skipped', null)
  if (readable.length === 0) {
    await applyOcrToPages(doc.id)
    return { done: true }
  }

  const buffer = await download(doc)
  const entries = new Map(readZipEntries(new Uint8Array(buffer)).map((e) => [e.path, e.bytes]))

  let engine: OcrEngine | null = null
  try {
    for (const asset of readable) {
      // Park BETWEEN images, never mid-recognition: a killed invocation would otherwise
      // leave the asset `pending` and redo it, which is correct but wasted.
      if (deadline - Date.now() < OCR_IMAGE_BUDGET_MS) {
        await applyOcrToPages(doc.id)
        return { done: false }
      }

      const bytes = entries.get(asset.entryPath)
      if (!bytes) {
        // The extraction stage recorded it, so the archive had it. Missing now means the
        // stored object changed underneath us — record it rather than failing the deck.
        await setAssetOcr(asset.id, 'failed', null)
        continue
      }

      engine ??= await createTesseractEngine()
      try {
        const text = await withTimeout(
          engine.recognize(bytes, asset.mimeType),
          OCR_IMAGE_TIMEOUT_MS,
          `OCR of ${asset.entryPath}`,
        )
        const usable = isUsableOcrText(text)
        await setAssetOcr(asset.id, 'done', usable ? text : null)
      } catch (error) {
        // One unreadable image must not fail an otherwise fine deck. It is recorded as
        // failed, which is visible in the coverage report — not silently treated as empty.
        logger.warn('ocr failed for one image', {
          documentId: doc.id,
          entryPath: asset.entryPath,
          message: error instanceof Error ? error.message : String(error),
        })
        await setAssetOcr(asset.id, 'failed', null)
      }
    }
  } finally {
    await engine?.close().catch(() => {})
  }

  await applyOcrToPages(doc.id)
  return { done: true }
}

async function setAssetOcr(id: string, status: string, text: string | null): Promise<void> {
  await db.update(documentAssets).set({ ocrStatus: status, ocrText: text }).where(eq(documentAssets.id, id))
}

/**
 * Fold finished per-image OCR up onto the pages it belongs to.
 *
 * `raw_text` is never touched. The recovered text lands in `ocr_text`, and `text_source`
 * records that the page is no longer purely digital — so a citation into an OCR'd slide is
 * distinguishable from one into text the file actually contained.
 */
async function applyOcrToPages(documentId: string): Promise<void> {
  const rows = await db
    .select({
      pageNumber: documentAssets.pageNumber,
      ocrText: documentAssets.ocrText,
    })
    .from(documentAssets)
    .where(and(eq(documentAssets.documentId, documentId), eq(documentAssets.ocrStatus, 'done')))
    .orderBy(documentAssets.pageNumber, documentAssets.assetIndex)

  const byPage = new Map<number, string[]>()
  for (const r of rows) {
    if (!r.ocrText) continue
    byPage.set(r.pageNumber, [...(byPage.get(r.pageNumber) ?? []), r.ocrText])
  }
  if (byPage.size === 0) return

  for (const [pageNumber, texts] of byPage) {
    await db
      .update(documentPages)
      .set({
        ocrText: texts.join('\n'),
        textSource: sql`CASE WHEN length(trim(${documentPages.rawText})) > 0 THEN 'mixed' ELSE 'ocr' END`,
        // The page produced text after all, so it is no longer unread.
        unreadReason: null,
      })
      .where(and(eq(documentPages.documentId, documentId), eq(documentPages.pageNumber, pageNumber)))
  }
}

/**
 * Find where the document's sections begin.
 *
 * A PDF asks Gemini, because a PDF is a river of text with no marked boundaries. A slide
 * deck does not: one slide IS one section, authored that way, so the offsets are exact
 * arithmetic over boundaries we already have. That makes PPTX ingestion free of generation
 * calls entirely — and skips the one failure mode the PDF path has to defend against, a
 * model returning offsets that do not line up with the text.
 */
async function structure(doc: Document, deadline: number): Promise<void> {
  const { fullText, pages } = await readPages(doc.id)
  if (pages.length === 0) throw new Error('no extracted pages to analyse')

  const sections =
    doc.sourceType === 'pptx'
      ? deriveSlideSections(pages)
      : await detectSections(
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

export interface Stage {
  from: IngestionState
  to: IngestionState
  run: (doc: Document, deadline: number) => Promise<StageResult>
}

export const STAGES: Stage[] = [
  { from: 'uploaded', to: 'ocr', run: (doc) => extract(doc) },
  { from: 'ocr', to: 'structuring', run: (doc, d) => ocrPass(doc, d) },
  { from: 'structuring', to: 'chunking', run: (doc, d) => structure(doc, d) },
  { from: 'chunking', to: 'embedding', run: (doc) => chunk(doc) },
  { from: 'embedding', to: 'ready', run: (doc) => embedAll(doc) },
]

/** A failed state resumes at the stage that failed. */
export const RESUME_AT: Partial<Record<IngestionState, IngestionState>> = {
  failed_extraction: 'uploaded',
  failed_ocr: 'ocr',
  failed_structuring: 'structuring',
  failed_chunking: 'chunking',
  failed_embedding: 'embedding',
}

export const FAILURE_OF: Record<string, { state: IngestionState; code: string }> = {
  uploaded: { state: 'failed_extraction', code: 'EXTRACTION_FAILED' },
  ocr: { state: 'failed_ocr', code: 'OCR_FAILED' },
  structuring: { state: 'failed_structuring', code: 'STRUCTURE_DETECTION_FAILED' },
  chunking: { state: 'failed_chunking', code: 'CHUNKING_FAILED' },
  embedding: { state: 'failed_embedding', code: 'EMBEDDING_FAILED' },
}

/**
 * Drive one document from wherever it is to `ready`, or to the failed state for the stage
 * that broke. Returns rather than throws: the caller is an HTTP route that needs to report
 * status, not a crash.
 */
export async function runIngestion(
  jobId: string,
  deadline: number,
  // Injected the same way detectSections() takes its client: so the driver's transition and
  // resume behaviour can be tested without standing up storage, Gemini and a database.
  stages: Stage[] = STAGES,
): Promise<IngestionOutcome> {
  const loaded = await loadJob(jobId)
  if (!loaded) return { status: 'failed_extraction', done: false, paused: false, errorCode: 'JOB_NOT_FOUND' }

  const { job } = loaded
  let doc = loaded.document
  let state = (RESUME_AT[doc.status as IngestionState] ?? doc.status) as IngestionState

  if (doc.status === 'ready') return { status: 'ready', done: true, paused: false }

  // A retry re-enters at the stage that FAILED, but the row still carries `failed_<stage>`.
  // Move it onto that stage before running anything, because every stage finishes by calling
  // advanceDocument(expected: state), whose WHERE pins the current status — against a row
  // still reading `failed_ocr` that matches nothing, and the stage's work is thrown away
  // with "document is no longer in state ocr" after it has already been done.
  //
  // Conditional on the failed value, so it stays the same claim-the-work lock the rest of
  // the pipeline uses: two concurrent retries cannot both take it.
  if (state !== doc.status) {
    doc = await advanceDocument(doc.id, doc.status as IngestionState, state, job.id)
  }

  while (state !== 'ready') {
    const stage = stages.find((s) => s.from === state)
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
      const result = await stage.run(doc, deadline)
      // A stage that ran out of budget partway has COMMITTED what it finished and asks to
      // be re-entered. Park without advancing: the document keeps this state, and the next
      // call resumes the same stage and skips the work already done. Only the ocr stage
      // uses this — the others are all-or-nothing and return nothing.
      if (result && result.done === false) {
        logger.info('ingestion stage paused mid-way', {
          documentId: doc.id,
          jobId: job.id,
          stage: state,
          durationMs: Date.now() - startedAt,
        })
        return { status: state, done: false, paused: true }
      }
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
