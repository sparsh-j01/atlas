import type { GoldenQuery } from '../documents/golden-queries'
import { coversAllEvidence, firstOverlapRank, spanToInterval, type GoldInterval } from './evidence'
import { PRODUCTION_TOP_K, type QueryOutcome } from './metrics'

// The grading loop, separated from `run.ts` so it can be exercised without a database, an
// API key or a seeded document. Everything here is the part that decides what a number
// means; `run.ts` is argument parsing and printing around it.
//
// Structural types rather than `RetrievalResult` from `lib/ai/retrieve`: that module imports
// `server-only`, and importing it from a test would drag the whole DB layer in to describe
// four fields.

export interface GradedResult {
  chunkId: string
  text: string
  similarity: number | null
  source: { charStart: number; charEnd: number }
}

export interface RetrieverLike<T extends GradedResult = GradedResult> {
  retrieve(query: string, topK: number): Promise<T[]>
  getLastTiming?: () => { totalMs: number; embeddingMs: number; searchMs: number; cacheStatus: 'cache_hit' | 'cache_miss' | 'not_applicable' } | undefined
}

/** Resolve every query's spans to source intervals. Throws on the first bad span: a dataset
 *  typo must stop the run, not silently grade one query against nothing for a year. */
export function resolveEvidence(fullText: string, queries: GoldenQuery[]): Map<string, GoldInterval[]> {
  const evidence = new Map<string, GoldInterval[]>()
  for (const q of queries) {
    if (q.evidenceSpans.length === 0) continue
    const intervals = q.evidenceSpans.map((span) => {
      const r = spanToInterval(fullText, span)
      // spanToInterval rejects a span occurring zero OR more than one time. The second case
      // is the one worth failing on: resolving to the first occurrence grades the wrong copy.
      if (!r.ok) throw new Error(`Golden dataset is broken — ${q.id}: ${r.error}`)
      return r.value
    })
    evidence.set(q.id, intervals)
  }
  return evidence
}

/**
 * THE CHECK THAT MAKES EVERY METRIC MEAN ANYTHING.
 *
 * Gold intervals are offsets into the PINNED corpus text. Retrieved chunks carry offsets
 * into whatever text was actually ingested. If those are not the same string, every overlap
 * comparison is between coordinates in two different documents and the eval reports
 * confident nonsense — most likely a plausible-looking low score that reads as a retrieval
 * problem and gets "fixed" by tuning the retriever.
 */
export function assertSameSource(fullText: string, results: GradedResult[], label: string): void {
  const drifted = results.find((r) => fullText.slice(r.source.charStart, r.source.charEnd) !== r.text)
  if (drifted) {
    throw new Error(
      `Ingested document is not the pinned text of ${label}: chunk ${drifted.chunkId} at ` +
        `[${drifted.source.charStart}, ${drifted.source.charEnd}) does not slice back to its own text. ` +
        `Re-seed from the corpus; grading offsets are meaningless otherwise.`,
    )
  }
}

export interface GradeRun {
  graded: QueryOutcome[]
  /** A negative query passes by ABSTAINING — the relevance floor should reject it rather
   *  than the pipeline confidently answering from an unrelated passage. */
  negatives: { abstained: boolean }[]
}

// Generic in the result type so a caller can hand in the real `RetrievalResult` and have its
// own predicate (`hasRelevantContext`) type-check against it, with no cast at the boundary.
export async function gradeQueries<T extends GradedResult>(
  retriever: RetrieverLike<T>,
  queries: GoldenQuery[],
  fullText: string,
  opts: { topK: number; label: string; isRelevant: (results: T[]) => boolean },
): Promise<GradeRun> {
  const evidence = resolveEvidence(fullText, queries)
  const run: GradeRun = { graded: [], negatives: [] }
  let sourceChecked = false

  for (const q of queries) {
    const started = Date.now()
    const results = await retriever.retrieve(q.query, opts.topK)
    const latencyMs = Date.now() - started
    const timing = retriever.getLastTiming?.()

    if (!sourceChecked && results.length > 0) {
      sourceChecked = true
      assertSameSource(fullText, results, opts.label)
    }

    const ev = evidence.get(q.id)
    if (!ev) {
      run.negatives.push({ abstained: !opts.isRelevant(results) })
      continue
    }

    const chunks = results.map((r) => ({
      chunkId: r.chunkId,
      charStart: r.source.charStart,
      charEnd: r.source.charEnd,
      text: r.text,
      similarity: r.similarity,
    }))
    const sims = results.map((r) => r.similarity).filter((s): s is number => s !== null)
    run.graded.push({
      query: q,
      rank: firstOverlapRank(chunks, ev),
      covered: coversAllEvidence(chunks.slice(0, PRODUCTION_TOP_K), ev),
      latencyMs,
      timing,
      // Null, not 0: an arm that returns no similarity (BM25-only) has not scored every
      // query as maximally irrelevant.
      topSimilarity: sims.length === 0 ? null : Math.max(...sims),
    })
  }
  return run
}
