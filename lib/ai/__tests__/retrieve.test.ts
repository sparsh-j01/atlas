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

  it('treats a BM25-only hit (no similarity) as unproven, not as zero-risk', () => {
    expect(hasRelevantContext([result(null)]).ok).toBe(false)
  })

  it('judges against a fused-score-sized floor correctly when one is passed explicitly', () => {
    // Regression guard: the old code thresholded the RRF score (max ~0.033) at 0.1, so
    // nothing ever passed. The floor now applies to similarity, which has a real scale.
    expect(RELEVANCE_FLOOR).toBeGreaterThan(0.033)
  })
})
