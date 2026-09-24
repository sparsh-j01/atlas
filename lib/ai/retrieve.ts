import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chunks, documents, documentSections, embeddings } from '@/lib/db/schema'
import { embed, embeddingConfig, type EmbedOptions } from './embed'
import { createBM25Index } from './bm25'
import { rrfFromChunks } from './rrf'

// Hybrid retrieval (M7 phases 6-8): dense vector search + BM25 keyword search, fused with
// reciprocal rank fusion.
//
// Built as a RETRIEVER rather than a bare function because one generation run issues one
// query per slide against the same corpus. The previous shape reloaded every chunk of the
// document and re-tokenised it into a fresh BM25 index on every single call — 20 slides
// meant 20 full rebuilds of the same index. Loading once and reusing is also what makes
// the chunk lookup free: the rows are already in memory, so fusion resolves against a Map
// instead of a second round trip.
//
//   createRetriever()  ── loads chunks + headings once, builds BM25 once
//        │
//        └─ retrieve(query) ─┬─ vector search   (pgvector, RETRIEVAL_QUERY embedding)
//                            ├─ BM25 search     (in-memory index)
//                            └─ RRF fuse ──> top-K with page/section provenance

export interface RetrievalResult {
  chunkId: string
  text: string
  /** Fused RRF score. Ranking only — see relevanceOf() for anything interpretable. */
  score: number
  rank: number
  /** Cosine similarity to the query, or null when only BM25 matched this chunk. */
  similarity: number | null
  source: {
    /** Which file the chunk came from: decks can be built from up to 5 (2026-10-05). The
     *  citation row stores the id; the filename labels the evidence in the prompt. */
    documentId: string
    filename: string
    page: number
    /** The section HEADING, not its id. This string goes into the model's prompt and into
     *  generation_sources.section, where a UUID would be noise to both. */
    section: string
    charStart: number
    charEnd: number
  }
}

// Exported so the eval manifest can RECORD the candidate pool each arm drew from.
// A three-arm comparison where the arms saw different pool sizes is rigged, and the
// only way to know is for the numbers to travel with the limits that produced them.
export const VECTOR_LIMIT = 20
export const BM25_LIMIT = 20

/**
 * Cosine similarity below which retrieved context is treated as "this document does not
 * cover the question."
 *
 * Deliberately applied to the SIMILARITY and not to the fused score. RRF scores are
 * 1/(k+rank) sums with k=60, so the best possible value is about 0.033 — comparing that
 * against a 0.1 floor rejected every result, which dropped every slide. A fused rank score
 * carries no scale you can threshold; a cosine similarity does.
 *
 * 0.5 -> 0.62 on 2026-09-09. At 0.5 this check had NEVER FIRED: the benchmark's 10
 * unanswerable queries were correctly refused 0 times out of 10 by the vector and hybrid
 * arms. 0.5 was calibrated against `text-embedding-004`; under `gemini-embedding-001` the
 * whole similarity distribution sits higher, so the floor was underneath every negative and
 * the pipeline would confidently generate questions from unrelated passages for a subtopic
 * the teacher's document does not cover. That is the hallucination this function exists to
 * prevent, and the #1 product risk in CLAUDE.md.
 *
 * Calibrated on benchmark run `4a5f2810` (40 answerable + 10 unanswerable queries, 3 docs):
 *
 *   answerable   topSimilarity  0.6350 – 0.7749
 *   unanswerable topSimilarity  0.5246 – 0.6793
 *
 * The bands OVERLAP by 0.0443, so no floor is clean and this number is a trade, not a
 * solution. 0.62 keeps 40/40 answerable queries and refuses 8/10 unanswerable ones. 0.63
 * refuses the same 8 with less headroom; 0.64 starts refusing real questions.
 *
 * ponytail: calibrated on the same 50 queries that measured it, so it is fitted to them —
 * a held-out document is what would confirm it. Upgrade path if false refusals show up in
 * the wild: per-document calibration, or a margin test (best vs. median similarity) rather
 * than an absolute floor, which is what the overlap really argues for.
 */
export const RELEVANCE_FLOOR = 0.62

type ChunkRow = {
  id: string
  documentId: string
  filename: string
  text: string
  tokenCount: number
  pageStart: number
  pageEnd: number
  charStart: number
  charEnd: number
  heading: string
}

export type RetrievalArm = 'vector' | 'bm25' | 'hybrid'

export interface RetrieveTiming {
  totalMs: number
  embeddingMs: number
  searchMs: number
  cacheStatus: 'cache_hit' | 'cache_miss' | 'not_applicable'
}

export interface RetrieveOptions extends EmbedOptions {
  arm?: RetrievalArm
  vectorLimit?: number
  bm25Limit?: number
  onTiming?: (timing: RetrieveTiming) => void
  /** Search only this file's chunks (one of the retriever's documents). A blueprint entry
   *  assigned to a file retrieves from that file, which is what makes every file contribute. */
  documentId?: string
}

export interface Retriever {
  retrieve(query: string, topK: number, options?: RetrieveOptions): Promise<RetrievalResult[]>
  /** Section headings in document order, file by file: the outline that grounds a blueprint. */
  outline(): { documentId: string; filename: string; heading: string; pageStart: number; pageEnd: number }[]
  /** The opening of chunks spread evenly through the corpus, about `maxChars` in all: what
   *  the material actually SAYS, for a blueprint whose headings alone say too little. */
  sample(maxChars?: number): { documentId: string; text: string }[]
  chunkCount(): number
}

/**
 * Drop vector hits whose chunk did not survive the owner-scoped corpus load.
 *
 * This is the second of two independent tenant-isolation controls, and the one that looks
 * removable. The corpus load joins `documents.ownerId`, but the vector SQL below it is
 * keyed on `documentId` ALONE — no owner predicate and no join to `documents`. So the set
 * of rows the database is willing to return here is wider than the set the caller is
 * allowed to see, and this filter is what closes the gap.
 *
 * It is deliberately a named export rather than an inline `.filter()`: as an anonymous
 * expression it reads as redundant with the join above, which is exactly how a future
 * cleanup deletes it. `evals/security/tenant-isolation.test.ts` fails if it stops
 * filtering, so the deletion cannot pass CI quietly.
 */
export function scopeHitsToCorpus<T extends { chunkId: string }>(
  hits: readonly T[],
  ownedChunks: { has(chunkId: string): boolean },
): T[] {
  return hits.filter((h) => ownedChunks.has(h.chunkId))
}

/**
 * Load one document's corpus and prepare it for repeated querying.
 *
 * `ownerId` is required and enforced in the query. Tenant isolation cannot live only in
 * the calling route: the retrieval layer is what turns a document id into document TEXT,
 * so it is the layer that has to prove the caller owns it. A caller that passes someone
 * else's id gets an empty corpus, not their content.
 */
export async function createRetriever(documentIds: string | string[], ownerId: string): Promise<Retriever> {
  const ids = [...new Set(Array.isArray(documentIds) ? documentIds : [documentIds])]
  const rows: ChunkRow[] = await db
    .select({
      id: chunks.id,
      documentId: chunks.documentId,
      filename: documents.filename,
      text: chunks.text,
      tokenCount: chunks.tokenCount,
      pageStart: chunks.pageStart,
      pageEnd: chunks.pageEnd,
      charStart: chunks.charStart,
      charEnd: chunks.charEnd,
      heading: documentSections.heading,
    })
    .from(chunks)
    .innerJoin(documents, eq(documents.id, chunks.documentId))
    .innerJoin(documentSections, and(
      eq(documentSections.id, chunks.sectionId),
      eq(documentSections.documentId, chunks.documentId),
    ))
    .where(and(inArray(chunks.documentId, ids), eq(documents.ownerId, ownerId)))
    // Files in the order given, chunks in reading order within each.
    .orderBy(sql`array_position(ARRAY[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}], ${chunks.documentId})`, chunks.chunkIndex)

  const byId = new Map(rows.map((r) => [r.id, r]))
  const index = createBM25Index(rows.map((r) => ({ id: r.id, text: r.text, tokenCount: r.tokenCount })))

  // Deduped per FILE: two files that both have an "Introduction" keep one entry each. Keyed
  // on heading alone, the second file's section vanished from the outline the blueprint is
  // written from, so that file quietly got fewer questions.
  const seen = new Set<string>()
  const outline = rows
    .filter((r) => {
      const key = `${r.documentId}\u0000${r.heading}`
      return !seen.has(key) && seen.add(key)
    })
    .map((r) => ({ documentId: r.documentId, filename: r.filename, heading: r.heading, pageStart: r.pageStart, pageEnd: r.pageEnd }))

  const cfg = embeddingConfig()
  const queryVectorCache = new Map<string, number[]>()

  async function embedQuery(query: string, options?: EmbedOptions): Promise<{ vector: number[]; cacheStatus: 'cache_hit' | 'cache_miss'; embeddingMs: number }> {
    const cached = queryVectorCache.get(query)
    if (cached) return { vector: cached, cacheStatus: 'cache_hit', embeddingMs: 0 }
    const start = Date.now()
    // No deadline means an offline caller (the evals), which can wait out the free tier's
    // per-minute limit. The generation route always passes its deadline and fails fast.
    let vec: number[]
    for (let attempt = 0; ; attempt++) {
      try {
        vec = await embed(query, 'RETRIEVAL_QUERY', options)
        break
      } catch (error) {
        const rateLimited = error instanceof Error && error.message.includes('embedding failed: 429')
        if (options?.deadline !== undefined || !rateLimited || attempt >= 4) throw error
        await new Promise((r) => setTimeout(r, (attempt + 1) * 15_000))
      }
    }
    const embeddingMs = Date.now() - start
    queryVectorCache.set(query, vec)
    return { vector: vec, cacheStatus: 'cache_miss', embeddingMs }
  }

  async function vectorSearch(
    query: string,
    limit = VECTOR_LIMIT,
    options?: EmbedOptions,
    scope?: string,
  ): Promise<{ hits: Map<string, number>; cacheStatus: 'cache_hit' | 'cache_miss'; embeddingMs: number }> {
    if (rows.length === 0) return { hits: new Map(), cacheStatus: 'cache_hit', embeddingMs: 0 }
    // RETRIEVAL_QUERY, not RETRIEVAL_DOCUMENT: Gemini projects questions and passages
    // differently, and using the passage task type for a question quietly costs recall.
    const { vector: queryVector, cacheStatus, embeddingMs } = await embedQuery(query, options)
    const literal = `[${queryVector.join(',')}]`
    const hits = await db
      .select({
        chunkId: chunks.id,
        similarity: sql<number>`1 - (${embeddings.vector} <=> ${literal}::vector)`,
      })
      .from(chunks)
      .innerJoin(embeddings, eq(embeddings.chunkId, chunks.id))
      .where(and(
        scope ? eq(chunks.documentId, scope) : inArray(chunks.documentId, ids),
        eq(embeddings.provider, cfg.provider),
        eq(embeddings.model, cfg.model),
        eq(embeddings.version, cfg.version),
        eq(embeddings.dimension, cfg.dimension),
      ))
      .orderBy(sql`${embeddings.vector} <=> ${literal}::vector`)
      .limit(limit)
    return {
      hits: new Map(scopeHitsToCorpus(hits, byId).map((h) => [h.chunkId, h.similarity])),
      cacheStatus,
      embeddingMs,
    }
  }

  return {
    chunkCount: () => rows.length,
    outline: () => outline,
    sample(maxChars = 6_000) {
      // ponytail: evenly spaced chunk openings, not a summary. A 300-chunk PDF shows 40 of
      // them; add a summarise step if big documents still get off-material topics.
      const n = Math.min(rows.length, 40)
      const each = Math.floor(maxChars / Math.max(n, 1))
      return Array.from({ length: n }, (_, i) => rows[Math.floor((i * rows.length) / n)]).map((r) => ({
        documentId: r.documentId,
        text: r.text.replace(/\s+/g, ' ').trim().slice(0, each),
      }))
    },
    async retrieve(query: string, topK: number, options?: RetrieveOptions): Promise<RetrievalResult[]> {
      if (rows.length === 0) return []
      const startMs = Date.now()
      const arm = options?.arm ?? 'hybrid'
      const vLimit = options?.vectorLimit ?? VECTOR_LIMIT
      const bLimit = options?.bm25Limit ?? BM25_LIMIT
      const scope = options?.documentId
      // BM25 scores over the whole corpus (one index per run); a scoped query keeps only that
      // file's hits, searching the full corpus first so the limit applies AFTER the filter.
      const keyword = () => scope
        ? index.search(query, rows.length).filter((k) => byId.get(k.documentId)?.documentId === scope).slice(0, bLimit)
        : index.search(query, bLimit)

      if (arm === 'vector') {
        const { hits: vectorHits, cacheStatus, embeddingMs } = await vectorSearch(query, vLimit, options, scope)
        const totalMs = Date.now() - startMs
        const searchMs = Math.max(0, totalMs - embeddingMs)
        options?.onTiming?.({ totalMs, embeddingMs, searchMs, cacheStatus })

        return [...vectorHits.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, topK)
          .flatMap(([chunkId, sim], i) => {
            const row = byId.get(chunkId)
            if (!row) return []
            return [
              {
                chunkId,
                text: row.text,
                score: sim,
                rank: i + 1,
                similarity: sim,
                source: {
                  documentId: row.documentId,
                  filename: row.filename,
                  page: row.pageStart,
                  section: row.heading,
                  charStart: row.charStart,
                  charEnd: row.charEnd,
                },
              },
            ]
          })
      }

      if (arm === 'bm25') {
        const keywordHits = keyword().slice(0, topK)
        const totalMs = Date.now() - startMs
        options?.onTiming?.({ totalMs, embeddingMs: 0, searchMs: totalMs, cacheStatus: 'not_applicable' })

        return keywordHits.flatMap((k, i) => {
          const row = byId.get(k.documentId)
          if (!row) return []
          return [
            {
              chunkId: k.documentId,
              text: row.text,
              score: k.score,
              rank: i + 1,
              similarity: null,
              source: {
                documentId: row.documentId,
                filename: row.filename,
                page: row.pageStart,
                section: row.heading,
                charStart: row.charStart,
                charEnd: row.charEnd,
              },
            },
          ]
        })
      }

      const [{ hits: vectorHits, cacheStatus, embeddingMs }, keywordHits] = await Promise.all([
        vectorSearch(query, vLimit, options, scope),
        Promise.resolve(keyword()),
      ])

      const totalMs = Date.now() - startMs
      const searchMs = Math.max(0, totalMs - embeddingMs)
      options?.onTiming?.({ totalMs, embeddingMs, searchMs, cacheStatus })

      const fused = rrfFromChunks(
        [...vectorHits].map(([chunkId, score]) => ({ chunkId, score })),
        keywordHits.map((r) => ({ chunkId: r.documentId, score: r.score })),
        topK,
      )

      return fused.flatMap((f, i) => {
        const row = byId.get(f.chunkId)
        // Unreachable while both searches are scoped to `rows`, but dropping an unknown id
        // beats the previous behaviour of throwing and failing the whole generation run.
        if (!row) return []
        return [
          {
            chunkId: f.chunkId,
            text: row.text,
            score: f.score,
            rank: i + 1,
            similarity: vectorHits.get(f.chunkId) ?? null,
            source: {
              documentId: row.documentId,
              filename: row.filename,
              page: row.pageStart,
              section: row.heading,
              charStart: row.charStart,
              charEnd: row.charEnd,
            },
          },
        ]
      })
    },
  }
}

/**
 * Is any retrieved chunk actually about the question? Answers on cosine similarity, which
 * has a scale, rather than on the fused rank score, which does not.
 *
 * Returning false is a normal outcome, not an error: the teacher's document simply may not
 * cover a subtopic, and generating a question anyway is exactly the hallucination the
 * grounding work exists to prevent.
 */
export function hasRelevantContext(
  results: RetrievalResult[],
  floor = RELEVANCE_FLOOR,
): { ok: true } | { ok: false; reason: string } {
  if (results.length === 0) return { ok: false, reason: 'NO_RELEVANT_CHUNKS' }
  const best = results.reduce((m, r) => Math.max(m, r.similarity ?? 0), 0)
  if (best < floor) return { ok: false, reason: `LOW_RELEVANCE_SCORE (${best.toFixed(3)} < ${floor})` }
  return { ok: true }
}
