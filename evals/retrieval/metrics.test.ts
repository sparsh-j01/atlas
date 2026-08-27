import { describe, it, expect } from 'vitest'
import { PRODUCTION_TOP_K, scoreByCategory, scoreOutcomes, type QueryOutcome } from './metrics'
import type { GoldenQuery, QueryCategory } from '../documents/golden-queries'

// Aggregation only. Grading is `evidence.ts` and is tested there; the substring grader that
// used to live in this file (`firstHitRank`) is gone, along with its tests.

const q = (id: string, category: QueryCategory = 'direct_fact'): GoldenQuery => ({
  id, documentId: 'd', query: 'q', category, evidenceSpans: ['x'],
})
const outcome = (rank: number, over: Partial<QueryOutcome> = {}): QueryOutcome => ({
  query: q(`q${rank}`), rank, covered: rank > 0 && rank <= PRODUCTION_TOP_K, latencyMs: 10, topSimilarity: 0.8, ...over,
})

describe('scoreOutcomes', () => {
  it('computes recall at each cutoff, including the production K', () => {
    const m = scoreOutcomes([outcome(1), outcome(6), outcome(9), outcome(11), outcome(0)], [])
    expect(m.recallAt5).toBe(0.2) // rank 1
    expect(m.recallAt8).toBe(0.4) // ranks 1, 6 — the cutoff production actually sees
    expect(m.recallAt10).toBe(0.6) // ranks 1, 6, 9
  })

  it('counts a miss as zero reciprocal rank rather than skipping it', () => {
    // Skipping misses would let a retriever that finds one thing out of ten score 1.0.
    expect(scoreOutcomes([outcome(1)], []).mrr).toBe(1)
    expect(scoreOutcomes([outcome(1), outcome(0)], []).mrr).toBe(0.5)
    expect(scoreOutcomes([outcome(1), outcome(2)], []).mrr).toBeCloseTo(0.75)
  })

  it('separates all-evidence recall from any-evidence recall', () => {
    // The distinction multi-interval evidence exists to expose: a query whose gold is split
    // across two chunks is a "hit" the moment one arrives, but is not answerable until both
    // do. A single recall number cannot say which happened.
    const partial = [outcome(1, { covered: false }), outcome(2, { covered: true })]
    const m = scoreOutcomes(partial, [])
    expect(m.recallAt8).toBe(1)
    expect(m.allEvidenceRecallAt8).toBe(0.5)
  })

  it('reports N/A rather than 100% when there are no negative queries', () => {
    // A vacuous "correctAbstentionRate = 100%" over zero examples reads as a passing score.
    expect(scoreOutcomes([outcome(1)], []).correctAbstentions).toBeNull()
    expect(scoreOutcomes([], [{ abstained: true }, { abstained: false }]).correctAbstentions).toBe(0.5)
  })

  it('reports p95 latency from the slow end, not the fast end', () => {
    const outcomes = [500, 10, 20, 30, 40].map((ms) => outcome(1, { latencyMs: ms }))
    expect(scoreOutcomes(outcomes, []).p95LatencyMs).toBe(500)
    expect(scoreOutcomes(outcomes, []).avgLatencyMs).toBe(120)
  })

  it('returns zeros for an empty run instead of dividing by zero', () => {
    const m = scoreOutcomes([], [])
    expect([m.recallAt5, m.recallAt8, m.recallAt10, m.mrr, m.avgLatencyMs, m.p95LatencyMs]).toEqual([0, 0, 0, 0, 0, 0])
  })

  it('keeps a null similarity null instead of scoring it as maximally irrelevant', () => {
    // BM25-only produces no cosine similarity. Coercing that to 0 would make the arm look
    // like it abstains on every query.
    expect(scoreOutcomes([outcome(1, { topSimilarity: null })], []).gradedQueries).toBe(1)
  })

  it('separates cold latency from warm latency when timing metadata is present', () => {
    const cold = outcome(1, {
      latencyMs: 550,
      timing: { totalMs: 550, embeddingMs: 480, searchMs: 70, cacheStatus: 'cache_miss' },
    })
    const warm = outcome(1, {
      latencyMs: 75,
      timing: { totalMs: 75, embeddingMs: 0, searchMs: 75, cacheStatus: 'cache_hit' },
    })

    const m = scoreOutcomes([cold, warm], [])
    expect(m.coldAvgLatencyMs).toBe(550)
    expect(m.warmAvgLatencyMs).toBe(75)
    expect(m.avgEmbeddingMs).toBe(240) // (480 + 0) / 2
    expect(m.avgSearchMs).toBe(72.5) // (70 + 75) / 2
    expect(m.cacheHits).toBe(1)
    expect(m.cacheMisses).toBe(1)
  })
})

describe('scoreByCategory', () => {
  it('scores each category separately, so a strong average cannot hide a dead category', () => {
    const by = scoreByCategory([
      outcome(1, { query: q('a', 'keyword_heavy') }),
      outcome(0, { query: q('b', 'semantic_paraphrase') }),
      outcome(0, { query: q('c', 'semantic_paraphrase') }),
    ])
    expect(by.get('keyword_heavy')!.mrr).toBe(1)
    expect(by.get('semantic_paraphrase')!.mrr).toBe(0)
    expect(by.get('semantic_paraphrase')!.gradedQueries).toBe(2)
  })
})
