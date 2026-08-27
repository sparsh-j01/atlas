import { config } from 'dotenv'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chunks, documentPages, documentSections, documents, embeddings, profiles } from '@/lib/db/schema'
import { chunkDocument, MAX_TOKENS } from '@/lib/ai/chunk'
import { embedBatch, embeddingConfig, EMBEDDING_DIMENSION } from '@/lib/ai/embed'
import { BM25_LIMIT, RELEVANCE_FLOOR, VECTOR_LIMIT } from '@/lib/ai/retrieve'
import { RRF_K } from '@/lib/ai/rrf'
import { GOLDEN_SET_VERSION, GOLDEN_QUERIES } from './documents/golden-queries'
import { buildSections, chunkRowId, EVAL_OWNER_ID, evalDocumentId } from './seed-ids'
import { CORPUS_DOCUMENTS, CORPUS_VERSION, corpusFullText, type CorpusDocument } from './documents/openstax-corpus'
import { PRODUCTION_TOP_K } from './retrieval/metrics'

// Deterministic seeder for the pinned OpenStax evaluation corpus (master doc section 4,
// section 20 step 6).
//
//   npm run eval:seed              # all three corpus documents
//   npm run eval:seed -- <id>      # one of them
//
// WHY THIS EXISTS RATHER THAN "just ingest the PDFs". Gold evidence is recorded as
// character offsets into the pinned corpus text, and `detectSections` is a LIVE model call
// — re-ingesting identical bytes yields different section boundaries, therefore different
// chunks, therefore different recall, therefore gold offsets that point at the wrong prose.
// So this deliberately does NOT run the ingestion state machine's `structure` stage. It
// builds sections from the corpus's own pinned `sectionTitles` and calls the real
// production `chunkDocument()` on the real pinned text.
//
// Everything else is the production path: the same chunker, the same `embedBatch(...,
// 'RETRIEVAL_DOCUMENT')`, the same tables, the same provenance columns. An eval that seeds
// through a private shortcut measures the shortcut.
//
// IDEMPOTENCY IS BY CONTENT, NOT BY TRUNCATION. Every id is derived from what it holds, so
// a re-run with an unchanged corpus computes the same ids, finds the rows present, and
// makes ZERO Gemini calls. A chunk whose text changed gets a different id, so its old row
// (and, by cascade, its embedding) is removed and only that one is re-embedded. Re-running
// is therefore free and safe, which is the property that stops anyone from hand-editing
// rows to fix a bad run.

config({ path: '.env.local', quiet: true })

// Free-tier embedding quota is per MINUTE, and a batchEmbedContents call appears to count
// once per REQUEST inside it, not once per HTTP call: 67 chunks went through, the next
// document's 70 came back 429 immediately, and a single request right after succeeded.
// So the limit is paced around here rather than retried blindly.
//
// This lives in the seeder, NOT in lib/ai/embed.ts. Production ingestion is a user waiting
// on an upload; sleeping a minute mid-request is the wrong behaviour there and changing it
// would be changing production behaviour to suit an eval.
// ponytail: fixed slice + fixed sleep, no token-bucket accounting. Seeding is a
// once-per-corpus operation, so the crude version costs ~3 minutes and nothing else. If
// this ever runs per-PR, read the quota headers instead of guessing.
const EMBED_SLICE = 50
const PACE_MS = 60_000
const RETRY_BACKOFF_MS = [65_000, 65_000]

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function embedPaced(texts: string[]): Promise<number[][]> {
  const out: number[][] = []
  for (let i = 0; i < texts.length; i += EMBED_SLICE) {
    const slice = texts.slice(i, i + EMBED_SLICE)
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await embedBatch(slice, 'RETRIEVAL_DOCUMENT')))
        break
      } catch (error) {
        const rateLimited = error instanceof Error && error.message.includes('embedding failed: 429')
        if (!rateLimited || attempt >= RETRY_BACKOFF_MS.length) throw error
        console.log(`    rate limited, waiting ${RETRY_BACKOFF_MS[attempt] / 1000}s`)
        await sleep(RETRY_BACKOFF_MS[attempt])
      }
    }
    if (i + EMBED_SLICE < texts.length) await sleep(PACE_MS)
  }
  return out
}

export interface SeedSummary {
  corpusId: string
  documentId: string
  pages: number
  sections: number
  chunks: number
  embeddings: number
  embeddingsComputed: number
}

async function seedDocument(doc: CorpusDocument): Promise<SeedSummary> {
  const fullText = corpusFullText(doc)
  const documentId = evalDocumentId(doc.id)

  // Corpus integrity BEFORE any write. If the pinned text has drifted from the hash it was
  // recorded under, every gold offset is wrong and seeding it would produce a benchmark
  // that looks plausible and measures nothing.
  const sha = createHash('sha256').update(fullText).digest('hex')
  if (sha !== doc.contentSha256)
    throw new Error(`${doc.id}: corpus text does not match its recorded sha256 (${sha} != ${doc.contentSha256})`)

  await db
    .insert(profiles)
    .values({ id: EVAL_OWNER_ID, email: null, displayName: 'Atlas eval corpus' })
    .onConflictDoNothing()

  await db
    .insert(documents)
    .values({
      id: documentId,
      ownerId: EVAL_OWNER_ID,
      filename: doc.filename,
      sourceType: 'pdf',
      status: 'ready',
      fileSize: Buffer.byteLength(fullText),
      pageCount: doc.pages.length,
      contentHash: doc.contentSha256,
      // Not a Storage object and deliberately not shaped like one: nothing was uploaded,
      // the bytes live in the repo. A plausible-looking bucket path would send someone
      // hunting for a file that does not exist.
      storagePath: `eval://${CORPUS_VERSION}/${doc.id}`,
    })
    .onConflictDoUpdate({
      target: documents.id,
      set: { status: 'ready', contentHash: doc.contentSha256, pageCount: doc.pages.length, updatedAt: new Date() },
    })

  // Pages are leaves — no FK points at them — so replacing wholesale is the cheap correct
  // move. Reassembling these with PAGE_SEPARATOR must reproduce `fullText` exactly; that is
  // asserted after the write, not assumed.
  await db.transaction(async (tx) => {
    await tx.delete(documentPages).where(eq(documentPages.documentId, documentId))
    await tx
      .insert(documentPages)
      .values(doc.pages.map((rawText, i) => ({ documentId, pageNumber: i + 1, rawText })))
  })

  const sections = buildSections(doc)
  const sectionIds = sections.map((s) => s.id)
  await db.transaction(async (tx) => {
    // Drops sections from an older corpus shape, taking their chunks and embeddings with
    // them by cascade. With a pinned corpus this deletes nothing; it is what keeps a
    // re-run correct rather than additive if the corpus is ever rebuilt.
    await tx
      .delete(documentSections)
      .where(and(eq(documentSections.documentId, documentId), notInArray(documentSections.id, sectionIds)))
    await tx
      .insert(documentSections)
      .values(
        sections.map((s) => ({
          id: s.id,
          documentId,
          heading: s.heading,
          pageStart: s.pageStart,
          pageEnd: s.pageEnd,
          startOffset: s.startOffset,
          endOffset: s.endOffset,
        })),
      )
      .onConflictDoNothing()
  })

  const results = await chunkDocument(fullText, sections)
  if (results.length === 0) throw new Error(`${doc.id}: chunking produced nothing`)

  const rows = results.map((c, i) => ({
    id: chunkRowId(documentId, i, c.contentHash),
    documentId,
    sectionId: c.sectionId,
    chunkIndex: i,
    pageStart: c.pageStart,
    pageEnd: c.pageEnd,
    charStart: c.charStart,
    charEnd: c.charEnd,
    text: c.text,
    tokenCount: c.tokenCount,
    contentHash: c.contentHash,
  }))

  await db.transaction(async (tx) => {
    await tx.delete(chunks).where(and(eq(chunks.documentId, documentId), notInArray(chunks.id, rows.map((r) => r.id))))
    await tx.insert(chunks).values(rows).onConflictDoNothing()
  })

  // Embed only what is missing UNDER THIS EXACT provider/model/version/dimension. The
  // unique index keeps two embedding populations addressable side by side, so switching
  // models re-embeds rather than silently mixing 768-dim vectors from two different models.
  const cfg = embeddingConfig()
  const present = await db
    .select({ chunkId: embeddings.chunkId })
    .from(embeddings)
    .where(
      and(
        inArray(embeddings.chunkId, rows.map((r) => r.id)),
        eq(embeddings.provider, cfg.provider),
        eq(embeddings.model, cfg.model),
        eq(embeddings.version, cfg.version),
        eq(embeddings.dimension, cfg.dimension),
      ),
    )
  const have = new Set(present.map((p) => p.chunkId))
  const missing = rows.filter((r) => !have.has(r.id))

  if (missing.length > 0) {
    console.log(`    embedding ${missing.length} chunks`)
    const vectors = await embedPaced(missing.map((r) => r.text))
    await db
      .insert(embeddings)
      .values(
        missing.map((r, i) => ({
          chunkId: r.id,
          provider: cfg.provider,
          model: cfg.model,
          version: cfg.version,
          dimension: cfg.dimension,
          vector: vectors[i],
        })),
      )
      .onConflictDoNothing()
  }

  await verify(doc, documentId, fullText)

  const [{ count: embeddingCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(embeddings)
    .innerJoin(chunks, eq(chunks.id, embeddings.chunkId))
    .where(eq(chunks.documentId, documentId))

  return {
    corpusId: doc.id,
    documentId,
    pages: doc.pages.length,
    sections: sections.length,
    chunks: rows.length,
    embeddings: embeddingCount,
    embeddingsComputed: missing.length,
  }
}

/**
 * Read the seeded rows BACK and prove the coordinates survived the round trip.
 *
 * This is the check the whole benchmark rests on: gold evidence is offsets into the pinned
 * text, retrieved chunks carry offsets into whatever was actually stored, and if those are
 * not the same string then every overlap comparison comes from two different documents.
 * `gradeQueries` refuses to grade when this is violated — catching it here means the seeder
 * fails loudly rather than the benchmark failing obscurely an hour later.
 */
async function verify(doc: CorpusDocument, documentId: string, fullText: string): Promise<void> {
  const pageRows = await db
    .select({ rawText: documentPages.rawText })
    .from(documentPages)
    .where(eq(documentPages.documentId, documentId))
    .orderBy(documentPages.pageNumber)
  const reassembled = pageRows.map((r) => r.rawText).join('\n\n')
  if (reassembled !== fullText)
    throw new Error(`${doc.id}: pages do not reassemble to the pinned text (${reassembled.length} vs ${fullText.length} chars)`)

  const chunkRows = await db
    .select({ id: chunks.id, charStart: chunks.charStart, charEnd: chunks.charEnd, text: chunks.text })
    .from(chunks)
    .where(eq(chunks.documentId, documentId))
    .orderBy(chunks.chunkIndex)
  for (const c of chunkRows) {
    if (fullText.slice(c.charStart, c.charEnd) !== c.text)
      throw new Error(`${doc.id}: chunk ${c.id} at [${c.charStart}, ${c.charEnd}) does not slice back to its own text`)
  }
}

/** The configuration a published number is only interpretable against. Written next to the
 *  run artifacts (master doc section 16) so a result can never be read without it. */
function writeManifest(summaries: SeedSummary[]): string {
  const cfg = embeddingConfig()
  const manifest = {
    seededAt: new Date().toISOString(),
    ownerId: EVAL_OWNER_ID,
    corpusVersion: CORPUS_VERSION,
    goldenSetVersion: GOLDEN_SET_VERSION,
    goldenQueries: {
      total: GOLDEN_QUERIES.length,
      gradable: GOLDEN_QUERIES.filter((q) => q.evidenceSpans.length > 0).length,
      negative: GOLDEN_QUERIES.filter((q) => q.evidenceSpans.length === 0).length,
    },
    embedding: { ...cfg, dimension: EMBEDDING_DIMENSION },
    chunking: { maxTokens: MAX_TOKENS, overlapTokens: 0 },
    retrieval: {
      vectorLimit: VECTOR_LIMIT,
      bm25Limit: BM25_LIMIT,
      rrfK: RRF_K,
      productionTopK: PRODUCTION_TOP_K,
      // Recorded, NOT tuned. An off-topic passage measured cosine 0.5573 against this
      // embedder, which is above the floor — that is a finding for the benchmark to
      // report, and moving the floor before the first run would be setting a threshold
      // from zero measurements.
      relevanceFloor: RELEVANCE_FLOOR,
    },
    documents: summaries,
  }
  mkdirSync('eval-results', { recursive: true })
  const path = 'eval-results/seed-manifest.json'
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
  return path
}

async function main(): Promise<void> {
  const only = process.argv.slice(2)
  const targets = only.length > 0 ? CORPUS_DOCUMENTS.filter((d) => only.includes(d.id)) : CORPUS_DOCUMENTS
  if (targets.length === 0) {
    console.error(`No corpus document matched. Known ids: ${CORPUS_DOCUMENTS.map((d) => d.id).join(', ')}`)
    process.exit(2)
  }

  console.log(`corpus ${CORPUS_VERSION}   owner ${EVAL_OWNER_ID}   embedder ${embeddingConfig().model}@${EMBEDDING_DIMENSION}`)
  const summaries: SeedSummary[] = []
  for (const doc of targets) {
    const started = Date.now()
    const s = await seedDocument(doc)
    summaries.push(s)
    console.log(
      `  ${s.corpusId.padEnd(30)} ${s.documentId}  pages ${s.pages}  sections ${s.sections}  ` +
        `chunks ${s.chunks}  embeddings ${s.embeddings} (${s.embeddingsComputed} computed)  ${Date.now() - started}ms`,
    )
  }

  console.log(`\nmanifest: ${writeManifest(summaries)}`)
  console.log(`\nRun the eval with:\n  EVAL_OWNER_ID=${EVAL_OWNER_ID} npm run eval -- ${summaries[0].documentId} ${summaries[0].corpusId}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
