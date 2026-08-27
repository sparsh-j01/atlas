import type { GoldenQuery, QueryCategory } from '../documents/golden-queries'

// Retrieval metrics: AGGREGATION ONLY.
//
// Grading — deciding whether a retrieved chunk answers a query — moved to
// `evidence.ts` and is now an interval overlap against source coordinates. This file used
// to own a `firstHitRank` that asked `chunk.text.includes(expectedSpan)`; that grader is
// deleted rather than deprecated, because two grading identities coexisting is how a run
// ends up scored by whichever one the caller happened to import.
//
// Everything here is a pure function over already-graded outcomes: no database, no API key,
// no network. The harness that produces the outcomes needs all three; these do not.

/** Chunks production actually feeds the generator: `EVIDENCE_TOP_K = 8` in
 *  `app/api/decks/generate-pdf/route.ts`. Recall@5 and @10 are reporting conventions;
 *  Recall@8 is the only one that predicts what generation will see. */
export const PRODUCTION_TOP_K = 8

export interface QueryTiming {
  totalMs: number
  embeddingMs: number
  searchMs: number
  cacheStatus: 'cache_hit' | 'cache_miss' | 'not_applicable'
}

export interface QueryOutcome {
  query: GoldenQuery
  /** 1-based rank of the first chunk overlapping ANY gold interval, 0 for a miss. */
  rank: number
  /** Whether EVERY gold interval was retrieved within the top `PRODUCTION_TOP_K`.
   *  Differs from `rank <= 8` only for multi-interval queries — which is the point: one
   *  half of the evidence is a hit, but not enough to answer from. */
  covered: boolean
  latencyMs: number
  timing?: QueryTiming
  /** Best cosine similarity in the retrieved set, or null for an arm that produces none
   *  (BM25-only). Never coerce null to 0: that reads as "maximally irrelevant" and would
   *  make a keyword arm look like it abstains on everything. */
  topSimilarity: number | null
}

export interface RetrievalMetrics {
  recallAt5: number
  recallAt8: number
  recallAt10: number
  mrr: number
  /** Share of queries where all required evidence arrived within `PRODUCTION_TOP_K`. */
  allEvidenceRecallAt8: number
  avgLatencyMs: number
  p95LatencyMs: number
  /** Decomposed latency metrics separating cold (API-bound) from warm (cached/in-memory) runs. */
  coldAvgLatencyMs?: number | null
  warmAvgLatencyMs?: number | null
  avgEmbeddingMs?: number
  avgSearchMs?: number
  cacheHits?: number
  cacheMisses?: number
  /** Share of negative queries that correctly abstained, or null when there are none.
   *  Null, not 1.0 — "100% correct abstention" over zero examples is a vacuous metric and
   *  reads as a passing score. */
  correctAbstentions: number | null
  gradedQueries: number
  negativeQueries: number
}

export function scoreOutcomes(
  graded: QueryOutcome[],
  negatives: { abstained: boolean }[],
): RetrievalMetrics {
  const n = graded.length
  const within = (k: number) => (n === 0 ? 0 : graded.filter((o) => o.rank > 0 && o.rank <= k).length / n)
  const latencies = graded.map((o) => o.latencyMs).sort((a, b) => a - b)

  const withTiming = graded.filter((o): o is QueryOutcome & { timing: QueryTiming } => Boolean(o.timing))
  const coldOutcomes = withTiming.filter((o) => o.timing.cacheStatus === 'cache_miss')
  const warmOutcomes = withTiming.filter((o) => o.timing.cacheStatus === 'cache_hit')

  const coldAvgLatencyMs =
    coldOutcomes.length > 0
      ? coldOutcomes.reduce((s, o) => s + o.timing.totalMs, 0) / coldOutcomes.length
      : null

  const warmAvgLatencyMs =
    warmOutcomes.length > 0
      ? warmOutcomes.reduce((s, o) => s + o.timing.totalMs, 0) / warmOutcomes.length
      : null

  const avgEmbeddingMs =
    withTiming.length > 0
      ? withTiming.reduce((s, o) => s + o.timing.embeddingMs, 0) / withTiming.length
      : 0

  const avgSearchMs =
    withTiming.length > 0
      ? withTiming.reduce((s, o) => s + o.timing.searchMs, 0) / withTiming.length
      : n === 0
        ? 0
        : graded.reduce((s, o) => s + o.latencyMs, 0) / n

  return {
    recallAt5: within(5),
    recallAt8: within(PRODUCTION_TOP_K),
    recallAt10: within(10),
    // Reciprocal rank, averaged. A miss contributes 0 rather than being skipped, otherwise
    // a retriever that finds nothing scores the same as one that finds everything.
    mrr: n === 0 ? 0 : graded.reduce((sum, o) => sum + (o.rank > 0 ? 1 / o.rank : 0), 0) / n,
    allEvidenceRecallAt8: n === 0 ? 0 : graded.filter((o) => o.covered).length / n,
    avgLatencyMs: n === 0 ? 0 : graded.reduce((s, o) => s + o.latencyMs, 0) / n,
    p95LatencyMs: n === 0 ? 0 : latencies[Math.min(n - 1, Math.ceil(0.95 * n) - 1)],
    coldAvgLatencyMs,
    warmAvgLatencyMs,
    avgEmbeddingMs,
    avgSearchMs,
    cacheHits: warmOutcomes.length,
    cacheMisses: coldOutcomes.length,
    correctAbstentions:
      negatives.length === 0 ? null : negatives.filter((r) => r.abstained).length / negatives.length,
    gradedQueries: n,
    negativeQueries: negatives.length,
  }
}

/** Per-category MRR and recall@8. The categories exist to make specific claims (keyword
 *  terms favour BM25, paraphrases favour vectors, distractors punish surface matching), so
 *  a single aggregate number hides the only thing the dataset was built to show. */
export function scoreByCategory(graded: QueryOutcome[]): Map<QueryCategory, RetrievalMetrics> {
  const groups = new Map<QueryCategory, QueryOutcome[]>()
  for (const o of graded) groups.set(o.query.category, [...(groups.get(o.query.category) ?? []), o])
  return new Map([...groups].map(([cat, os]) => [cat, scoreOutcomes(os, [])]))
}

// NO THRESHOLDS HERE, DELIBERATELY.
//
// This file used to export THRESHOLDS = { recallAt5: 0.85, recallAt10: 0.95, mrr: 0.8,
// correctAbstentions: 1.0 } and fail the run against them. Those numbers predated any
// measurement, and were written against a corpus on which plain BM25 scored 1.000 — so
// they encoded nothing, and whichever way the first real benchmark landed would have been
// believed for the wrong reason. They are deleted rather than relaxed: a live gate with an
// invented number is worse than no gate, because it looks like evidence.
//
// Thresholds get set AFTER the first benchmark, from measured baselines, as regression
// guards. Until then `npm run eval` reports and exits 0.
