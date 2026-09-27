import 'server-only'

import { after } from 'next/server'
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm'
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
import { advanceDocument, claimDocument, failDocument, releaseDocument, type IngestionState } from '@/lib/documents'
import { chunkDocument, type IdentifiedSection } from '@/lib/ai/chunk'
import { detectSections, type SourcePage } from '@/lib/ai/structure'
import { embedBatch, embeddingConfig, EmbeddingDeadlineError } from '@/lib/ai/embed'
import { geminiGenerate } from '@/lib/ai/gemini'
import { logger } from '@/lib/logger'
import { extractPptx } from '@/lib/ingest/pptx'
import { deriveSlideSections } from '@/lib/ingest/sections'
import { isTextPoor } from '@/lib/ingest/coverage'
import {
  MAX_IMAGE_TILES,
  canOcr,
  imageDimensions,
  imageTiles,
  imageTokenCeiling,
  isUsableOcrText,
  ocrModel,
  planBatches,
  transcribeBatch,
  withDiagram,
  type OcrImage,
} from '@/lib/ingest/ocr'
import { readZipEntries } from '@/lib/ingest/zip'
import { documentStoragePath } from '@/lib/storage-path'

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
/** One background run: the work budget, inside the hard stop. Both process and confirm declare
 *  `maxDuration = 300` (Vercel Hobby's maximum with fluid compute; Next needs the literal in
 *  the route file). A stage is only started with budget left, but one that is already
 *  running, or an AI call it is waiting on, can overrun the budget up to the hard stop. */
export const RUN_BUDGET_MS = 240_000
export const RUN_MAX_DURATION_MS = 300_000
/** Past the deadline far enough that the lease outlives the invocation itself: 240s budget →
 *  lease to 315s, past the 300s kill. A run must never be writing after its lease lapses, or a
 *  Resume could start a second driver beside it. (It was deadline + 15s while the budget sat
 *  10s under maxDuration; a 280s budget under 300s would have left a 5s overlap.) */
const LEASE_MARGIN_MS = RUN_MAX_DURATION_MS - RUN_BUDGET_MS + 15_000
// A round of OCR requests is only STARTED with this much budget left: one Gemini call can take
// its 30s timeout plus a retry delay, and the run must still commit before the hard stop.
const OCR_ROUND_BUDGET_MS = 40_000
const OCR_CONCURRENCY = 2

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

/** Source bytes already in hand for the current run, by document id. /confirm downloads the
 *  file to check it and passes it in, and extraction and OCR reuse it, so one run fetches the
 *  file once instead of three times. Cleared when the run ends; a resumed run fetches fresh. */
const runBytes = new Map<string, Buffer | null>()

/** The stored source bytes. Every stage that needs the original file goes through here. */
async function download(doc: Document): Promise<Buffer> {
  const held = runBytes.get(doc.id)
  if (held) return held
  const bytes = await fetchStored(doc)
  if (runBytes.has(doc.id)) runBytes.set(doc.id, bytes) // only inside a run, see runIngestion
  return bytes
}

async function fetchStored(doc: Document): Promise<Buffer> {
  const admin = createAdminClient()
  const path = documentStoragePath(doc)
  if (!path) throw new Error('storage path does not match the document owner, hash and type')
  const { data, error } = await admin.storage.from('documents').download(path)
  if (error || !data) throw new Error('Document download failed')
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
      unreadReason: text[i]?.trim() ? undefined : 'empty',
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
 * Recover text from embedded images, for the pages that need it, with Gemini vision.
 *
 * Images go in batches (planBatches: at most BATCH_MAX_IMAGES and BATCH_MAX_BYTES each), two
 * requests at a time. Each finished image is committed on its own, so running out of budget
 * is a pause rather than a loss and a resumed run skips everything already read.
 *
 * Outcomes per image: done (text, or null when what came back was not language), skipped
 * (not text-poor, a format Gemini does not take, too large to bound, or the AI budget ran
 * out), failed (missing from the archive, unreadable header, or its request failed). Skipped
 * and failed pages surface in the coverage report with their reason; one bad image never
 * fails the deck. The exception is a deck with NO text anywhere whose images were refused by
 * the AI budget: that fails with AI_BUDGET_REACHED and leaves the images pending, so a Resume
 * once the budget allows picks them up (eng review 2026-10-05, Issue 9A).
 *
 * A no-op for every PDF: nothing is text-poor because nothing has assets, so the stage finds
 * no work and advances immediately.
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

  // Everything else is deliberately not read, and says so rather than staying `pending`
  // forever and re-querying on every resume.
  for (const a of pending) if (!wanted.includes(a) || !canOcr(a.mimeType)) await setAssetOcr(a.id, 'skipped', null)
  const readable = wanted.filter((a) => canOcr(a.mimeType))
  if (readable.length === 0) {
    await applyOcrToPages(doc.id)
    return { done: true }
  }

  const buffer = await download(doc)
  const entries = new Map(readZipEntries(new Uint8Array(buffer)).map((e) => [e.path, e.bytes]))

  type Item = { asset: (typeof readable)[number]; bytes: Uint8Array; image: OcrImage }
  const items: Item[] = []
  const tooLarge: number[] = []
  for (const asset of readable) {
    const bytes = entries.get(asset.entryPath)
    // The extraction stage recorded it, so the archive had it: missing now means the stored
    // object changed underneath us. An unreadable header means its cost cannot be bounded.
    const dims = bytes ? imageDimensions(bytes, asset.mimeType) : null
    if (!bytes || !dims) {
      await setAssetOcr(asset.id, 'failed', null)
      continue
    }
    if (imageTiles(dims) > MAX_IMAGE_TILES) {
      await setAssetOcr(asset.id, 'skipped', null)
      tooLarge.push(asset.pageNumber)
      continue
    }
    items.push({ asset, bytes, image: { bytes, mimeType: asset.mimeType, tokenCeiling: imageTokenCeiling(dims) } })
  }
  await markPagesUnread(doc.id, tooLarge, 'image_too_large')

  const generate = geminiGenerate(ocrModel())
  const batches = planBatches(items)
  const refused: Item[] = []
  const failed: Item[] = []
  for (let i = 0; i < batches.length; i += OCR_CONCURRENCY) {
    // Park BETWEEN rounds, never mid-request: a killed invocation would leave its images
    // pending and redo them, which is correct but paid for twice.
    if (deadline - Date.now() < OCR_ROUND_BUDGET_MS) {
      await applyOcrToPages(doc.id)
      return { done: false }
    }
    await Promise.all(
      batches.slice(i, i + OCR_CONCURRENCY).map(async (batch) => {
        const result = await transcribeBatch(generate, batch.map((b) => b.image), deadline)
        if (!result.ok) {
          if (!result.budget) logger.warn('ocr batch failed', { documentId: doc.id })
          return void (result.budget ? refused : failed).push(...batch)
        }
        for (const [j, b] of batch.entries())
          await setAssetOcr(b.asset.id, 'done', isUsableOcrText(result.texts[j]) ? withDiagram(result.texts[j], result.diagrams[j]) : null)
      }),
    )
  }

  if (refused.length > 0 || failed.length > 0) {
    // Nothing readable anywhere: fail the stage and leave these images `pending`, so a retry
    // re-reads them. Reporting "no readable text" here would send the teacher off to fix a
    // file that is fine (the provider refused, or the month's budget ran out).
    const anyText = pages.some((p) => p.rawText.trim().length > 0) || (await hasOcrText(doc.id))
    if (!anyText)
      throw refused.length > 0
        ? new IngestionError('AI_BUDGET_REACHED', 'AI budget reached before any text was read')
        : new IngestionError('OCR_FAILED', 'every OCR request failed')
    for (const f of failed) await setAssetOcr(f.asset.id, 'failed', null)
    for (const r of refused) await setAssetOcr(r.asset.id, 'skipped', null)
    await markPagesUnread(doc.id, refused.map((r) => r.asset.pageNumber), 'ai_budget')
  }

  await applyOcrToPages(doc.id)
  return { done: true }
}

/** Say WHY a text-less page stayed unread. Pages with digital text are never unread. A page
 *  whose other image is read after all is cleared again by applyOcrToPages. */
async function markPagesUnread(documentId: string, pageNumbers: number[], reason: 'image_too_large' | 'ai_budget'): Promise<void> {
  if (pageNumbers.length === 0) return
  await db
    .update(documentPages)
    .set({ unreadReason: reason })
    .where(and(
      eq(documentPages.documentId, documentId),
      inArray(documentPages.pageNumber, [...new Set(pageNumbers)]),
      sql`length(trim(${documentPages.rawText})) = 0`,
    ))
}

async function hasOcrText(documentId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: documentAssets.id })
    .from(documentAssets)
    .where(and(eq(documentAssets.documentId, documentId), eq(documentAssets.ocrStatus, 'done'), isNotNull(documentAssets.ocrText)))
    .limit(1)
  return Boolean(row)
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
  // Every page empty even after OCR: retrying cannot help, so it gets its own code rather
  // than STRUCTURE_DETECTION_FAILED's "Try again".
  if (!fullText.trim()) throw new IngestionError('NO_READABLE_TEXT', 'no text on any page, even after OCR')

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
  const { fullText, pages } = await readPages(doc.id)
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
  const results = await chunkDocument(fullText, identified, { pages })
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

async function embedAll(doc: Document, deadline: number): Promise<StageResult> {
  const cfg = embeddingConfig()
  const rows = await db
    .select({ id: chunks.id, text: chunks.text, embeddingId: embeddings.id })
    .from(chunks)
    .leftJoin(embeddings, and(
      eq(embeddings.chunkId, chunks.id),
      eq(embeddings.provider, cfg.provider),
      eq(embeddings.model, cfg.model),
      eq(embeddings.version, cfg.version),
      eq(embeddings.dimension, cfg.dimension),
    ))
    .where(eq(chunks.documentId, doc.id))
    .orderBy(chunks.chunkIndex)
  if (rows.length === 0) throw new Error('no chunks to embed')

  const pending = rows.filter((row) => !row.embeddingId)
  for (let i = 0; i < pending.length; i += 100) {
    if (deadline - Date.now() < MIN_STAGE_BUDGET_MS) return { done: false }
    const batch = pending.slice(i, i + 100)
    let vectors: number[][]
    try {
      vectors = await embedBatch(batch.map((r) => r.text), 'RETRIEVAL_DOCUMENT', { deadline: deadline - 2_000 })
    } catch (error) {
      if (error instanceof EmbeddingDeadlineError) return { done: false }
      throw error
    }
    // Commit every batch. A continuation skips these rows instead of spending again.
    await db.insert(embeddings).values(batch.map((r, j) => ({
      chunkId: r.id, ...cfg, vector: vectors[j],
    }))).onConflictDoNothing({
      target: [embeddings.chunkId, embeddings.provider, embeddings.model, embeddings.version],
    })
  }
  return { done: true }
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
  { from: 'embedding', to: 'ready', run: (doc, d) => embedAll(doc, d) },
]

/** A failed state resumes at the stage that failed. */
export const RESUME_AT: Partial<Record<IngestionState, IngestionState>> = {
  failed_extraction: 'uploaded',
  failed_ocr: 'ocr',
  failed_structuring: 'structuring',
  failed_chunking: 'chunking',
  failed_embedding: 'embedding',
}

/** A stage failure that knows a more specific code than its stage's default in FAILURE_OF. */
export class IngestionError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
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
  prefetched?: Buffer,
): Promise<IngestionOutcome> {
  const loaded = await loadJob(jobId)
  if (!loaded) return { status: 'failed_extraction', done: false, paused: false, errorCode: 'JOB_NOT_FOUND' }

  const { job } = loaded
  let doc = loaded.document
  let state = (RESUME_AT[doc.status as IngestionState] ?? doc.status) as IngestionState

  if (doc.status === 'ready') return { status: 'ready', done: true, paused: false }

  // One driver at a time; see claimDocument. A second Process click while this one works
  // gets the current state back as a pause and polls again, rather than paying for the stage.
  const lease = await claimDocument(doc.id, new Date(deadline + LEASE_MARGIN_MS))
  if (!lease) return { status: doc.status as IngestionState, done: false, paused: true }
  runBytes.set(doc.id, prefetched ?? null)
  try {
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
        // call resumes the same stage and skips the work already done. OCR and embedding
        // checkpoint individual images or batches before pausing.
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
        const stageFailure = FAILURE_OF[state] ?? { state: 'failed_extraction' as IngestionState, code: 'UNKNOWN_ERROR' }
        const failure = error instanceof IngestionError ? { ...stageFailure, code: error.code } : stageFailure
        logger.error('ingestion stage failed', {
          documentId: doc.id,
          jobId: job.id,
          stage: state,
          code: failure.code,
          durationMs: Date.now() - startedAt,
          // Security review F05: a failed insert's message carries its SQL parameters, which
          // here are the document's own text. The logger keeps only the SQLSTATE/category.
          error,
        })
        const landed = await failDocument(doc.id, state, failure.state, job.id, failure.code, 'Document processing failed.')
        // Not ours any more: a concurrent driver advanced it, or it was deleted. Report a pause
        // so the browser polls again and sees the real state (or the 404), rather than showing
        // a failure for a document that is in fact progressing.
        if (!landed) return { status: state, done: false, paused: true }
        return { status: failure.state, done: false, paused: false, errorCode: failure.code }
      }
    }

    return { status: 'ready', done: true, paused: false }
  } finally {
    runBytes.delete(doc.id)
    await releaseDocument(doc.id, lease)
  }
}

/**
 * Run ingestion in the background: after the response is sent, inside the same invocation,
 * for up to RUN_BUDGET_MS. The browser only polls GET /process for status, so closing the tab
 * no longer stops processing (it used to: the page drove every stage).
 *
 * A run that pauses on its budget, or is killed at the hard stop, is picked up by an explicit
 * Resume: GET reports `stalled` once nothing holds the lease, and the page or the dashboard
 * POSTs /process again (eng review 2026-10-05, Issue 3A). Nothing restarts it unattended.
 * ponytail: no scheduler. Every-minute resume needs Vercel Pro cron or Supabase pg_cron; add
 * it only if logs show files stalling under the 300s budget.
 */
export function startIngestion(jobId: string, prefetched?: Buffer): void {
  after(async () => {
    try {
      await runIngestion(jobId, Date.now() + RUN_BUDGET_MS, STAGES, prefetched)
    } catch (error) {
      // runIngestion turns stage failures into document state; reaching here means loading
      // the job or the lease itself failed. The lease, if taken, lapses on its own.
      logger.error('ingestion run threw', { jobId, error })
    }
  })
}
