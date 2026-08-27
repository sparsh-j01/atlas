import type { QueryGenerationOutcome } from '../generation/metrics'

/**
 * Phase 2C, master doc section 11 — reliability across repeated runs.
 *
 * A single run says what happened once. This says whether the pipeline does the same thing
 * twice, which is the question a teacher actually has: the deck they generate on Tuesday
 * should not be materially worse than the one they generated on Monday.
 */

export type FailureClass =
  /** The provider did not answer. Says nothing about the pipeline. */
  | 'transient'
  /** The query failed the same way in EVERY repetition. Reproducible, so it is a property
   *  of the pipeline or the query, not of luck. */
  | 'systematic'
  /** An unanswerable query that was correctly refused. A success wearing a failure's shape. */
  | 'expected_refusal'
  /** An answerable query that failed for a non-provider reason, but not every time. */
  | 'unexpected'

export interface QueryReliability {
  queryId: string
  repetitions: number
  /** Repetitions that produced an accepted slide. */
  successes: number
  successRate: number
  /** Whether every repetition agreed, either all succeeding or all failing. Instability is
   *  the interesting signal: a query that works 3 times in 5 is worse than one that never
   *  works, because it looks fine in a demo. */
  stable: boolean
  failureClass: FailureClass | null
  failureReasons: Record<string, number>
  meanLatencyMs: number
  stdDevLatencyMs: number
}

export interface ReliabilityMetrics {
  repetitions: number
  queriesPerRepetition: number
  totalObservations: number

  successfulRuns: number
  failedRuns: number
  inconclusiveRuns: number

  /** Of observations that reached the model. */
  successRate: number
  /** Queries whose outcome was identical in every repetition. */
  stableQueries: number
  unstableQueries: number
  stabilityRate: number

  regenerationCount: number
  validationFailureCount: number
  groundingFailureCount: number

  meanEndToEndLatencyMs: number
  p95EndToEndLatencyMs: number
  stdDevEndToEndLatencyMs: number

  failureClassDistribution: Record<FailureClass, number>
  failureReasonDistribution: Record<string, number>

  perQuery: QueryReliability[]
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0
  const m = mean(xs)
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]
}

/** A short, groupable reason. Raw provider text carries ids and quota numbers that would
 *  make every occurrence unique and the distribution useless. */
export function normaliseReason(reason: string | undefined): string {
  if (!reason) return 'none'
  const r = reason.toLowerCase()
  if (r.includes('429')) return 'provider_rate_limited'
  if (r.includes('503') || r.includes('502') || r.includes('500')) return 'provider_unavailable'
  if (r.includes('abort') || r.includes('time budget') || r.includes('timeout')) return 'timeout'
  if (r.includes('low_relevance')) return 'relevance_floor'
  if (r.includes('no_relevant_chunks')) return 'no_evidence'
  if (r.includes('schema') || r.includes('validation')) return 'schema_invalid'
  if (r.includes('judge') || r.includes('verif')) return 'judge_rejected'
  if (r.includes('unsupported') || r.includes('grounding')) return 'not_grounded'
  return 'other'
}

const TRANSIENT = new Set(['provider_rate_limited', 'provider_unavailable', 'timeout'])

/** Repetitions of ONE query, in order. */
export function scoreQuery(queryId: string, runs: QueryGenerationOutcome[]): QueryReliability {
  const reached = runs.filter((r) => r.abstentionClass !== 'inconclusive')
  const successes = runs.filter((r) => r.finalSlide !== null).length
  const latencies = runs.map((r) => r.totalLatencyMs)

  const failureReasons: Record<string, number> = {}
  for (const r of runs.filter((r) => r.finalSlide === null)) {
    const k = normaliseReason(r.failureReason)
    failureReasons[k] = (failureReasons[k] ?? 0) + 1
  }

  const isUnanswerable = runs[0]?.query.category === 'unanswerable'
  const allFailed = successes === 0
  const stable = successes === 0 || successes === runs.length

  let failureClass: FailureClass | null = null
  if (successes < runs.length) {
    const reasons = Object.keys(failureReasons)
    if (isUnanswerable && allFailed) failureClass = 'expected_refusal'
    else if (reached.length === 0) failureClass = 'transient'
    else if (reasons.every((r) => TRANSIENT.has(r))) failureClass = 'transient'
    // Reproducible across every repetition, so it is not chance.
    else if (allFailed && runs.length > 1) failureClass = 'systematic'
    else failureClass = 'unexpected'
  }

  return {
    queryId,
    repetitions: runs.length,
    successes,
    successRate: runs.length === 0 ? 0 : successes / runs.length,
    stable,
    failureClass,
    failureReasons,
    meanLatencyMs: mean(latencies),
    stdDevLatencyMs: stdDev(latencies),
  }
}

/** `byQuery` maps a query id to its outcomes across every repetition, in order. */
export function scoreReliability(
  byQuery: Map<string, QueryGenerationOutcome[]>,
  repetitions: number,
): ReliabilityMetrics {
  const perQuery = [...byQuery.entries()].map(([id, runs]) => scoreQuery(id, runs))
  const all = [...byQuery.values()].flat()

  const inconclusiveRuns = all.filter((o) => o.abstentionClass === 'inconclusive').length
  const successfulRuns = all.filter((o) => o.finalSlide !== null).length
  const evaluable = all.length - inconclusiveRuns
  const latencies = all.map((o) => o.totalLatencyMs)

  const failureClassDistribution: Record<FailureClass, number> = {
    transient: 0,
    systematic: 0,
    expected_refusal: 0,
    unexpected: 0,
  }
  for (const q of perQuery) if (q.failureClass) failureClassDistribution[q.failureClass] += 1

  const failureReasonDistribution: Record<string, number> = {}
  for (const q of perQuery) {
    for (const [k, n] of Object.entries(q.failureReasons)) {
      failureReasonDistribution[k] = (failureReasonDistribution[k] ?? 0) + n
    }
  }

  return {
    repetitions,
    queriesPerRepetition: byQuery.size,
    totalObservations: all.length,
    successfulRuns,
    failedRuns: evaluable - successfulRuns,
    inconclusiveRuns,
    successRate: evaluable === 0 ? 0 : successfulRuns / evaluable,
    stableQueries: perQuery.filter((q) => q.stable).length,
    unstableQueries: perQuery.filter((q) => !q.stable).length,
    stabilityRate: perQuery.length === 0 ? 0 : perQuery.filter((q) => q.stable).length / perQuery.length,
    regenerationCount: all.filter((o) => (o.attempts ?? []).length > 1).length,
    // Defensive on schemaErrors: scoring runs AFTER every model call has been paid for,
    // so a shape surprise here would throw away a run that cost real money and time.
    validationFailureCount: all.flatMap((o) => o.attempts ?? []).filter((a) => (a?.schemaErrors ?? []).length > 0).length,
    groundingFailureCount: all.filter((o) => o.finalSlide !== null && !o.grounded).length,
    meanEndToEndLatencyMs: mean(latencies),
    p95EndToEndLatencyMs: percentile(latencies, 0.95),
    stdDevEndToEndLatencyMs: stdDev(latencies),
    failureClassDistribution,
    failureReasonDistribution,
    perQuery,
  }
}
