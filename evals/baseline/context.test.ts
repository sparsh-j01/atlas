import { describe, it, expect, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { buildBaselineContext, compareArms, comparabilityOf, BASELINE_CONTEXT_TOKENS } =
  await import('./context')
const { CORPUS_DOCUMENTS, corpusFullText } = await import('../documents/openstax-corpus')
const { RELEVANCE_FLOOR } = await import('@/lib/ai/retrieve')

/**
 * Phase 2E, master doc section 14. The truncation rule is called BLOCKING there, so it is
 * tested here rather than trusted: if the baseline silently truncates, every "RAG wins"
 * delta measures the truncation and not retrieval.
 */
describe('baseline context', () => {
  it('passes the whole document through when it fits', () => {
    const text = 'a '.repeat(1000)
    const ctx = buildBaselineContext(text)
    expect(ctx.truncated).toBe(false)
    expect(ctx.droppedFraction).toBe(0)
    expect(ctx.evidence).toHaveLength(1)
    expect(ctx.evidence[0].text).toBe(text)
  })

  it('reports truncation rather than hiding it', () => {
    const text = 'word '.repeat(200_000)
    const ctx = buildBaselineContext(text, 1_000)
    expect(ctx.truncated).toBe(true)
    expect(ctx.droppedFraction).toBeGreaterThan(0.9)
    expect(ctx.evidence[0].text.length).toBeLessThan(text.length)
  })

  it('sits above the relevance floor, because the baseline has no relevance gate', () => {
    // If the floor abstained here, the baseline would be scored on a control it is defined
    // not to have, and the comparison would be rigged in RAG's favour.
    const ctx = buildBaselineContext('short text')
    expect(ctx.evidence[0].similarity!).toBeGreaterThan(RELEVANCE_FLOOR)
  })

  it('fits every real corpus document inside the budget', () => {
    // The precondition the master doc says to record as fact, not assume. If this ever
    // fails, the headline comparison stops being publishable.
    for (const doc of CORPUS_DOCUMENTS) {
      const ctx = buildBaselineContext(corpusFullText(doc))
      expect(ctx.truncated, `${doc.id} exceeds the ${BASELINE_CONTEXT_TOKENS}-token baseline budget`).toBe(false)
    }
  })
})

describe('comparability', () => {
  it('is publishable only when nothing was dropped', () => {
    const ok = comparabilityOf(buildBaselineContext('a '.repeat(100)))
    expect(ok.publishable).toBe(true)
    expect(ok.reason).toContain('whole document')
  })

  it('refuses the headline claim when the baseline was truncated', () => {
    const bad = comparabilityOf(buildBaselineContext('word '.repeat(200_000), 1_000))
    expect(bad.publishable).toBe(false)
    expect(bad.reason).toContain('TRUNCATION-CONFOUNDED')
  })
})

describe('deltas', () => {
  const arm = (over: Partial<Parameters<typeof compareArms>[0]> = {}) => ({
    groundedRate: 0.5,
    supportedGenerationRate: 0.5,
    schemaValidRate: 1,
    unsupportedGenerationCount: 2,
    supportedGenerationCount: 5,
    meanLatencyMs: 4000,
    evaluableQueries: 10,
    inconclusiveCount: 0,
    ...over,
  })

  it('reports a positive delta when RAG scored higher', () => {
    const d = compareArms(arm(), arm({ groundedRate: 0.9 }))
    expect(d.find((x) => x.metric === 'groundedness')!.delta).toBeCloseTo(0.4, 5)
  })

  it('flips the sign where lower is better, so the column reads consistently', () => {
    // RAG producing FEWER unsupported generations is an improvement, so it must show as
    // positive alongside the rate metrics.
    const d = compareArms(arm({ unsupportedGenerationCount: 5 }), arm({ unsupportedGenerationCount: 1 }))
    expect(d.find((x) => x.metric === 'unsupported generation')!.delta).toBe(4)

    const l = compareArms(arm({ meanLatencyMs: 9000 }), arm({ meanLatencyMs: 4000 }))
    expect(l.find((x) => x.metric === 'mean latency ms')!.delta).toBe(5000)
  })

  it('reports a negative delta when the baseline won', () => {
    // The result this experiment has to be able to produce. A comparison that can only
    // show RAG winning is not an experiment.
    const d = compareArms(arm({ groundedRate: 0.9 }), arm({ groundedRate: 0.4 }))
    expect(d.find((x) => x.metric === 'groundedness')!.delta).toBeCloseTo(-0.5, 5)
  })

  it('does not manufacture a retrieval score for the baseline', () => {
    const metrics = compareArms(arm(), arm()).map((d) => d.metric)
    for (const forbidden of ['recall', 'mrr', 'retrieval', 'ndcg']) {
      expect(metrics.some((m) => m.toLowerCase().includes(forbidden))).toBe(false)
    }
  })
})
