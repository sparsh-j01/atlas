import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { scoreQuery, scoreReliability, normaliseReason, mean, stdDev, percentile } =
  await import('./metrics')
import type { QueryGenerationOutcome } from '../generation/metrics'

/** Minimal outcome shaped like the generator's, with only the fields reliability reads. */
function outcome(over: Partial<QueryGenerationOutcome> & { id?: string } = {}): QueryGenerationOutcome {
  const { id = 'q1', ...rest } = over
  return {
    query: { id, documentId: 'doc', query: 'q', category: 'direct_fact', evidenceSpans: ['x'] },
    documentId: 'doc',
    relevancePassed: true,
    attempts: [],
    finalSlide: null,
    isDuplicate: false,
    isNearDuplicate: false,
    grounded: false,
    correct: false,
    abstentionClass: 'supported_generation',
    totalLatencyMs: 1000,
    ...rest,
  } as QueryGenerationOutcome
}

const slide = { id: 's', type: 'quiz_mcq', prompt: 'p', config: {} } as never

describe('normaliseReason', () => {
  it('groups provider failures by kind, not by their text', () => {
    // Raw provider text carries ids and quota numbers, so every occurrence would be unique
    // and the distribution would have a count of 1 for everything.
    expect(normaliseReason('api_error: provider returned 429')).toBe('provider_rate_limited')
    expect(normaliseReason('provider returned 503')).toBe('provider_unavailable')
    expect(normaliseReason('aborted (no time budget left to retry)')).toBe('timeout')
    expect(normaliseReason('LOW_RELEVANCE_SCORE (0.412 < 0.5)')).toBe('relevance_floor')
    expect(normaliseReason('NO_RELEVANT_CHUNKS')).toBe('no_evidence')
    expect(normaliseReason(undefined)).toBe('none')
  })
})

describe('statistics', () => {
  it('computes mean, sample standard deviation and p95', () => {
    expect(mean([2, 4, 6])).toBe(4)
    expect(stdDev([2, 4, 6])).toBeCloseTo(2, 5)
    // One observation has no spread; reporting 0 beats reporting NaN into an artifact.
    expect(stdDev([5])).toBe(0)
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95)).toBe(10)
    expect(percentile([], 0.95)).toBe(0)
  })
})

describe('per-query reliability', () => {
  it('marks a query stable when every repetition agreed', () => {
    const r = scoreQuery('q1', [outcome({ finalSlide: slide }), outcome({ finalSlide: slide })])
    expect(r.stable).toBe(true)
    expect(r.successRate).toBe(1)
    expect(r.failureClass).toBeNull()
  })

  it('marks a query unstable when the same input gave different outcomes', () => {
    // The case worth surfacing: a query that works most of the time looks fine in a demo
    // and fails in a classroom.
    const r = scoreQuery('q1', [
      outcome({ finalSlide: slide }),
      outcome({ finalSlide: null, failureReason: 'judge rejected the answer key' }),
      outcome({ finalSlide: slide }),
    ])
    expect(r.stable).toBe(false)
    expect(r.successRate).toBeCloseTo(2 / 3, 5)
    expect(r.failureClass).toBe('unexpected')
  })

  it('calls a reproducible failure systematic, not unexpected', () => {
    const r = scoreQuery('q1', [
      outcome({ finalSlide: null, failureReason: 'judge rejected the answer key' }),
      outcome({ finalSlide: null, failureReason: 'judge rejected the answer key' }),
      outcome({ finalSlide: null, failureReason: 'judge rejected the answer key' }),
    ])
    expect(r.failureClass).toBe('systematic')
    expect(r.stable).toBe(true)
  })

  it('classifies provider failures as transient, never as pipeline behaviour', () => {
    const r = scoreQuery('q1', [
      outcome({ finalSlide: null, abstentionClass: 'inconclusive', failureReason: 'provider returned 429' }),
      outcome({ finalSlide: null, abstentionClass: 'inconclusive', failureReason: 'provider returned 503' }),
    ])
    expect(r.failureClass).toBe('transient')
  })

  it('treats a refused unanswerable query as expected, not as a failure', () => {
    const unanswerable = {
      query: { id: 'u1', documentId: 'doc', query: 'q', category: 'unanswerable', evidenceSpans: [] },
    } as Partial<QueryGenerationOutcome>
    const r = scoreQuery('u1', [
      outcome({ ...unanswerable, finalSlide: null, abstentionClass: 'correct_abstention_floor', failureReason: 'LOW_RELEVANCE_SCORE (0.3 < 0.5)' }),
      outcome({ ...unanswerable, finalSlide: null, abstentionClass: 'correct_abstention_floor', failureReason: 'LOW_RELEVANCE_SCORE (0.3 < 0.5)' }),
    ])
    expect(r.failureClass).toBe('expected_refusal')
  })
})

describe('aggregate reliability', () => {
  it('excludes inconclusive observations from the success rate', () => {
    const m = scoreReliability(
      new Map([
        ['q1', [outcome({ finalSlide: slide }), outcome({ finalSlide: slide })]],
        ['q2', [outcome({ finalSlide: null, abstentionClass: 'inconclusive', failureReason: '429' }), outcome({ finalSlide: slide })]],
      ]),
      2,
    )
    expect(m.totalObservations).toBe(4)
    expect(m.inconclusiveRuns).toBe(1)
    // 3 successes over 3 reachable observations, not over 4.
    expect(m.successRate).toBe(1)
  })

  it('reports stability separately from success', () => {
    const m = scoreReliability(
      new Map([
        ['q1', [outcome({ finalSlide: slide }), outcome({ finalSlide: slide })]],
        ['q2', [outcome({ finalSlide: slide }), outcome({ finalSlide: null, failureReason: 'judge rejected' })]],
      ]),
      2,
    )
    expect(m.stableQueries).toBe(1)
    expect(m.unstableQueries).toBe(1)
    expect(m.stabilityRate).toBe(0.5)
  })

  it('counts regenerations from attempts, not from failures', () => {
    const m = scoreReliability(
      new Map([['q1', [
        outcome({ finalSlide: slide, attempts: [
          { attemptIndex: 1, rawOutput: null, slide: null, schemaErrors: ['bad shape'], judgeVerdict: null, latencyMs: 10 },
          { attemptIndex: 2, rawOutput: null, slide, schemaErrors: [], judgeVerdict: null, latencyMs: 10 },
        ] as never }),
        outcome({ finalSlide: slide, attempts: [
          { attemptIndex: 1, rawOutput: null, slide, schemaErrors: [], judgeVerdict: null, latencyMs: 10 },
        ] as never }),
      ]]]),
      2,
    )
    expect(m.regenerationCount).toBe(1)
    // One attempt across both observations failed schema validation.
    expect(m.validationFailureCount).toBe(1)
  })

  it('does not report a success rate from an all-inconclusive run', () => {
    const m = scoreReliability(
      new Map([['q1', [
        outcome({ finalSlide: null, abstentionClass: 'inconclusive', failureReason: '429' }),
        outcome({ finalSlide: null, abstentionClass: 'inconclusive', failureReason: '429' }),
      ]]]),
      2,
    )
    expect(m.successRate).toBe(0)
    expect(m.failureClassDistribution.transient).toBe(1)
  })
})
