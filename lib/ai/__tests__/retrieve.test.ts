import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { hasRelevantContext, RELEVANCE_FLOOR } = await import('../retrieve')
import type { RetrievalResult } from '../retrieve'

const result = (similarity: number | null): RetrievalResult => ({
  chunkId: 'c',
  text: 'text',
  score: 0.03,
  rank: 1,
  similarity,
  source: { page: 1, section: 'S', charStart: 0, charEnd: 4 },
})

describe('hasRelevantContext', () => {
  it('rejects an empty result set', () => {
    expect(hasRelevantContext([])).toEqual({ ok: false, reason: 'NO_RELEVANT_CHUNKS' })
  })

  it('accepts a similarity at or above the floor', () => {
    expect(hasRelevantContext([result(RELEVANCE_FLOOR)]).ok).toBe(true)
    expect(hasRelevantContext([result(0.9)]).ok).toBe(true)
  })

  it('rejects a similarity below the floor and says what it was', () => {
    const v = hasRelevantContext([result(0.2)])
    expect(v.ok).toBe(false)
    expect(v.ok === false && v.reason).toContain('LOW_RELEVANCE_SCORE')
  })

  it('judges on the best chunk, not the first', () => {
    expect(hasRelevantContext([result(0.1), result(0.95)]).ok).toBe(true)
  })

  // Calibration guard. The existing cases above all reference RELEVANCE_FLOOR relatively, so
  // they passed happily for months while the floor sat at 0.5 and refused 0 of 10 unanswerable
  // queries in the benchmark — a check that never fires passes every test written that way.
  // These two pin the floor against the measured bands from run `4a5f2810` instead, so moving
  // it means confronting the calibration rather than quietly disabling the refusal again.
  const MEASURED_ANSWERABLE_MIN = 0.635 // lowest topSimilarity across 40 answerable queries
  const MEASURED_UNANSWERABLE_MEDIAN = 0.603 // median across the 10 unanswerable ones

  it('is low enough to accept every answerable query measured in the benchmark', () => {
    expect(RELEVANCE_FLOOR).toBeLessThanOrEqual(MEASURED_ANSWERABLE_MIN)
    expect(hasRelevantContext([result(MEASURED_ANSWERABLE_MIN)]).ok).toBe(true)
  })

  it('is high enough to actually refuse a typical unanswerable query', () => {
    // The bands overlap by 0.0443, so this cannot catch all ten. It must catch the median.
    expect(RELEVANCE_FLOOR).toBeGreaterThan(MEASURED_UNANSWERABLE_MEDIAN)
    expect(hasRelevantContext([result(MEASURED_UNANSWERABLE_MEDIAN)]).ok).toBe(false)
  })

  it('treats a BM25-only hit (no similarity) as unproven, not as zero-risk', () => {
    expect(hasRelevantContext([result(null)]).ok).toBe(false)
  })

  it('judges against a fused-score-sized floor correctly when one is passed explicitly', () => {
    // Regression guard: the old code thresholded the RRF score (max ~0.033) at 0.1, so
    // nothing ever passed. The floor now applies to similarity, which has a real scale.
    expect(RELEVANCE_FLOOR).toBeGreaterThan(0.033)
  })
})
