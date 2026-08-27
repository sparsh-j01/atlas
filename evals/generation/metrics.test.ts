import { describe, expect, it } from 'vitest'
import {
  calculateTokenSimilarity,
  detectDuplicates,
  scoreGenerationOutcomes,
  type AbstentionClassification,
  type GenerationAttempt,
  type QueryGenerationOutcome,
} from './metrics'
import type { GoldenQuery } from '../documents/golden-queries'
import type { EditableSlide } from '@/lib/slides'

const sampleQuery = (id: string, isUnanswerable = false): GoldenQuery => ({
  id,
  documentId: 'openstax-social-psychology',
  query: isUnanswerable ? 'What is the aquarium pH?' : 'What is diffusion of responsibility?',
  category: isUnanswerable ? 'unanswerable' : 'direct_fact',
  evidenceSpans: isUnanswerable ? [] : ['Diffusion of responsibility is the tendency'],
})

const sampleSlide = (prompt: string): EditableSlide => ({
  type: 'quiz_mcq',
  prompt,
  options: [
    { id: '1', text: 'Tendency for no one in a group to help', is_correct: true },
    { id: '2', text: 'A chemical reaction', is_correct: false },
    { id: '3', text: 'An individual acting alone', is_correct: false },
    { id: '4', text: 'A biological process', is_correct: false },
  ],
  points: 1000,
  timeLimitMs: 20000,
})

const attempt = (over: Partial<GenerationAttempt> = {}): GenerationAttempt => ({
  attemptIndex: 1,
  rawOutput: {},
  slide: sampleSlide('Q'),
  schemaErrors: [],
  judgeVerdict: { ok: true, failures: [] },
  latencyMs: 1000,
  success: true,
  providerFailed: false,
  ...over,
})

const outcome = (
  id: string,
  abstentionClass: AbstentionClassification,
  over: Partial<QueryGenerationOutcome> = {},
): QueryGenerationOutcome => ({
  query: sampleQuery(id, id.startsWith('u')),
  documentId: 'd1',
  relevancePassed: true,
  attempts: [attempt()],
  finalSlide: abstentionClass === 'supported_generation' ? sampleSlide(`slide ${id}`) : null,
  isDuplicate: false,
  isNearDuplicate: false,
  grounded: abstentionClass === 'supported_generation',
  correct: abstentionClass === 'supported_generation',
  abstentionClass,
  totalLatencyMs: 1000,
  ...over,
})

describe('calculateTokenSimilarity', () => {
  it('returns 1.0 for identical prompts', () => {
    expect(calculateTokenSimilarity('What is photosynthesis?', 'what is photosynthesis')).toBe(1)
  })

  it('computes Jaccard similarity for overlapping words', () => {
    const sim = calculateTokenSimilarity(
      'What is diffusion of responsibility in a group?',
      'What is diffusion of responsibility in psychology?',
    )
    expect(sim).toBeGreaterThan(0.6)
    expect(sim).toBeLessThan(1.0)
  })

  it('returns 0 for disjoint prompts', () => {
    expect(calculateTokenSimilarity('apple orange banana', 'quantum physics astronomy')).toBe(0)
  })
})

describe('detectDuplicates', () => {
  it('identifies exact duplicate questions', () => {
    const outcomes = [
      outcome('q1', 'supported_generation', {
        finalSlide: sampleSlide('What is diffusion of responsibility?'),
      }),
      outcome('q2', 'supported_generation', {
        finalSlide: sampleSlide('what is diffusion of responsibility'),
      }),
    ]

    detectDuplicates(outcomes)
    expect(outcomes[0].isDuplicate).toBe(false)
    expect(outcomes[1].isDuplicate).toBe(true)
    expect(outcomes[1].duplicateOfQueryId).toBe('q1')
  })

  it('identifies near duplicate questions', () => {
    const outcomes = [
      outcome('q1', 'supported_generation', {
        finalSlide: sampleSlide('What percentage of Asch participants conformed to group pressure?'),
      }),
      outcome('q2', 'supported_generation', {
        finalSlide: sampleSlide('What percentage of Asch participants conformed to group pressure at least once?'),
      }),
    ]

    detectDuplicates(outcomes)
    expect(outcomes[0].isNearDuplicate).toBe(false)
    expect(outcomes[1].isNearDuplicate).toBe(true)
    expect(outcomes[1].duplicateOfQueryId).toBe('q1')
  })

  it('clears stale flags so a second pass over a different grouping cannot inherit them', () => {
    // scoreGenerationOutcomes runs per-document AND over the pooled set. Without the reset,
    // a duplicate found in the narrow pass stayed flagged in a grouping that never saw it.
    const outcomes = [
      outcome('q1', 'supported_generation', { finalSlide: sampleSlide('Unique question one') }),
      outcome('q2', 'supported_generation', {
        finalSlide: sampleSlide('Completely different question two'),
        isDuplicate: true,
        duplicateOfQueryId: 'ghost',
      }),
    ]

    detectDuplicates(outcomes)
    expect(outcomes[1].isDuplicate).toBe(false)
    expect(outcomes[1].duplicateOfQueryId).toBeUndefined()
  })
})

describe('scoreGenerationOutcomes', () => {
  it('aggregates groundedness, supported generation and abstention over evaluable queries', () => {
    const outcomes: QueryGenerationOutcome[] = [
      outcome('q1', 'supported_generation'),
      outcome('u1', 'correct_abstention_floor', { relevancePassed: false, attempts: [] }),
      outcome('q2', 'supported_generation', {
        attempts: [
          attempt({
            slide: sampleSlide('Bad Q2'),
            judgeVerdict: { ok: false, failures: ['answer key unsupported'] },
            success: false,
            failure: 'answer key unsupported',
          }),
          attempt({ attemptIndex: 2, slide: sampleSlide('Good Q2') }),
        ],
        totalLatencyMs: 2100,
      }),
    ]

    const m = scoreGenerationOutcomes(outcomes)

    expect(m.totalQueries).toBe(3)
    expect(m.inconclusiveCount).toBe(0)
    expect(m.evaluableQueries).toBe(3)
    expect(m.answerableQueries).toBe(2)
    expect(m.unanswerableQueries).toBe(1)

    expect(m.schemaValidRate).toBe(1.0)
    expect(m.groundedRate).toBe(1.0)
    expect(m.supportedGenerationRate).toBe(1.0)
    expect(m.abstentionAccuracy).toBe(1.0)

    expect(m.firstPassSuccessCount).toBe(1)
    expect(m.firstPassSuccessRate).toBeCloseTo(1 / 3)
    expect(m.regenerationCount).toBe(1)
    expect(m.regenerationRate).toBeCloseTo(1 / 3)
    expect(m.regenerationReasonDistribution['answer key unsupported']).toBe(1)
  })

  it('EXCLUDES inconclusive queries from every denominator', () => {
    // THE REGRESSION GUARD. The 2026-08-23 run 429'd on all ten unanswerable queries and
    // banked every one as a correct refusal, reporting 100% abstention accuracy over a run
    // that produced five slides out of fifty. A quota wall must never look like a safety
    // result, so an inconclusive query contributes to nothing but its own count.
    const outcomes: QueryGenerationOutcome[] = [
      outcome('q1', 'supported_generation'),
      outcome('u1', 'inconclusive', {
        attempts: [attempt({ success: false, providerFailed: true, slide: null, failure: 'provider_error: 429' })],
      }),
      outcome('u2', 'inconclusive', {
        attempts: [attempt({ success: false, providerFailed: true, slide: null, failure: 'provider_error: 429' })],
      }),
      outcome('u3', 'correct_abstention_judge', {
        attempts: [
          attempt({
            success: false,
            judgeVerdict: { ok: false, failures: ['not answerable from the document'] },
            failure: 'not answerable from the document',
          }),
        ],
      }),
    ]

    const m = scoreGenerationOutcomes(outcomes)

    expect(m.totalQueries).toBe(4)
    expect(m.inconclusiveCount).toBe(2)
    expect(m.inconclusiveRate).toBe(0.5)
    expect(m.evaluableQueries).toBe(2)
    // One real unanswerable survived; the two 429s are gone from the denominator entirely.
    expect(m.unanswerableQueries).toBe(1)
    expect(m.correctAbstentionCount).toBe(1)
    expect(m.abstentionAccuracy).toBe(1.0)
    // Under the old code this was 3/3 = 100% and read as a safety guarantee.
    expect(m.correctAbstentionCount).not.toBe(3)
  })

  it('reports null abstention accuracy rather than 1.0 when no unanswerable query was evaluable', () => {
    const m = scoreGenerationOutcomes([
      outcome('q1', 'supported_generation'),
      outcome('u1', 'inconclusive', {
        attempts: [attempt({ success: false, providerFailed: true, slide: null })],
      }),
    ])
    expect(m.abstentionAccuracy).toBeNull()
  })

  it('scores schema validity per attempt, so a malformed first payload costs something', () => {
    const m = scoreGenerationOutcomes([
      outcome('q1', 'supported_generation', {
        attempts: [
          attempt({ slide: null, schemaErrors: ['unusable_schema_payload'], success: false }),
          attempt({ attemptIndex: 2 }),
        ],
      }),
    ])
    // 1 of 2 attempts that returned a payload was schema-valid. The old query-level metric
    // asked "did an accepted slide have no schema errors" and could only ever answer 100%.
    expect(m.payloadAttempts).toBe(2)
    expect(m.schemaValidAttempts).toBe(1)
    expect(m.schemaValidRate).toBe(0.5)
  })

  it('does not count a provider-failed attempt as a schema-valid payload', () => {
    const m = scoreGenerationOutcomes([
      outcome('q1', 'inconclusive', {
        attempts: [attempt({ slide: null, schemaErrors: [], success: false, providerFailed: true })],
      }),
    ])
    expect(m.payloadAttempts).toBe(0)
    expect(m.schemaValidRate).toBe(0)
  })
})
