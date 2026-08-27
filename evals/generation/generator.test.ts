import { describe, expect, it, vi } from 'vitest'

// `generator.ts` reaches `lib/ai/retrieve` for `hasRelevantContext`, and that module imports
// `server-only`, which throws outside a React Server Component. Stubbed rather than excluded
// from the suite — an excluded file is how untested code hides behind a green run.
vi.mock('server-only', () => ({}))

const { evaluateQueryGeneration } = await import('./generator')
import type { GenerateFn, GenerateResult } from '@/lib/ai/generate'
import type { RetrievalResult } from '@/lib/ai/retrieve'
import type { GoldenQuery } from '../documents/golden-queries'
import type { CorpusDocument } from '../documents/openstax-corpus'

// The classification logic decides what every number in the Phase 2B report MEANS, and it
// shipped with no test at all — which is how "no slide was produced" came to be scored as a
// correct refusal regardless of whether the model was ever reached.

const FULL_TEXT =
  'Diffusion of responsibility is the tendency for no one in a group to help because ' +
  'everyone assumes someone else will. Bystander apathy follows from it directly.'

const GOLD_SPAN = 'Diffusion of responsibility is the tendency'

const doc = { id: 'openstax-social-psychology', filename: 'social-psychology.pdf' } as CorpusDocument

const answerable: GoldenQuery = {
  id: 'q1',
  documentId: 'openstax-social-psychology',
  query: 'What is diffusion of responsibility?',
  category: 'direct_fact',
  evidenceSpans: [GOLD_SPAN],
}

const unanswerable: GoldenQuery = {
  id: 'u1',
  documentId: 'openstax-social-psychology',
  query: 'What is the filing fee for a provisional patent?',
  category: 'unanswerable',
  evidenceSpans: [],
}

/** Evidence overlapping the gold interval, above the relevance floor (0.5). */
function evidence(similarity = 0.82, charStart = 0, charEnd = 100): RetrievalResult[] {
  return [
    {
      chunkId: 'c1',
      text: FULL_TEXT.slice(charStart, charEnd),
      score: 0.03,
      rank: 1,
      similarity,
      source: { page: 1, section: 'Helping Behaviour', charStart, charEnd },
    },
  ]
}

const GOOD_SLIDE = {
  prompt: 'What does diffusion of responsibility describe?',
  options: [
    { text: 'Nobody helps because each assumes another will', is_correct: true },
    { text: 'A chemical gradient across a membrane', is_correct: false },
    { text: 'One person acting entirely alone', is_correct: false },
  ],
  explanation: 'The passage defines it as the tendency for no one in a group to help.',
}

/** A client that replays a scripted response per call, in order. */
function scriptedClient(responses: GenerateResult[]): { fn: GenerateFn; calls: number } {
  const state = { calls: 0 }
  const fn: GenerateFn = async () => {
    const r = responses[Math.min(state.calls, responses.length - 1)]
    state.calls++
    return r
  }
  return {
    fn,
    get calls() {
      return state.calls
    },
  }
}

const slideOk = (): GenerateResult => ({ ok: true, input: GOOD_SLIDE })
const judgeOk = (): GenerateResult => ({
  ok: true,
  input: { answerable: true, correct_option_supported: true, exactly_one_correct: true },
})
const judgeNo = (): GenerateResult => ({
  ok: true,
  input: {
    answerable: false,
    correct_option_supported: false,
    exactly_one_correct: false,
    reason: 'the extracts do not cover this',
  },
})
const rateLimited = (): GenerateResult => ({ ok: false, error: 'provider returned 429: quota exceeded' })

describe('evaluateQueryGeneration', () => {
  it('classifies an answerable query with a passing judge as supported and grounded', async () => {
    const { fn } = scriptedClient([slideOk(), judgeOk()])
    const out = await evaluateQueryGeneration(answerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.abstentionClass).toBe('supported_generation')
    expect(out.correct).toBe(true)
    expect(out.grounded).toBe(true)
    expect(out.finalSlide).not.toBeNull()
    expect(out.attempts).toHaveLength(1)
    expect(out.attempts[0].providerFailed).toBe(false)
  })

  it('is NOT grounded when the accepted slide came from evidence that misses the gold interval', async () => {
    // The judge is satisfied, but the retrieved chunk does not overlap the gold coordinates.
    // This is the only metric that can disagree with the judge, so it has to be able to.
    const { fn } = scriptedClient([slideOk(), judgeOk()])
    const offGold = evidence(0.82, 120, 160) // past the gold span
    const out = await evaluateQueryGeneration(answerable, doc, FULL_TEXT, offGold, fn)

    expect(out.abstentionClass).toBe('supported_generation')
    expect(out.correct).toBe(true)
    expect(out.grounded).toBe(false)
  })

  it('abstains at the relevance floor without calling the provider at all', async () => {
    const client = scriptedClient([slideOk()])
    const out = await evaluateQueryGeneration(unanswerable, doc, FULL_TEXT, evidence(0.2), client.fn)

    expect(out.abstentionClass).toBe('correct_abstention_floor')
    expect(out.relevancePassed).toBe(false)
    expect(out.attempts).toHaveLength(0)
    expect(client.calls).toBe(0)
    expect(out.failureReason).toContain('LOW_RELEVANCE_SCORE')
  })

  it('records a floor rejection on an ANSWERABLE query as a false abstention', async () => {
    const { fn } = scriptedClient([slideOk()])
    const out = await evaluateQueryGeneration(answerable, doc, FULL_TEXT, evidence(0.2), fn)
    expect(out.abstentionClass).toBe('false_abstention')
  })

  it('classifies a judge that ACTUALLY REFUSED an unanswerable query as a correct abstention', async () => {
    const { fn } = scriptedClient([slideOk(), judgeNo()])
    const out = await evaluateQueryGeneration(unanswerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.abstentionClass).toBe('correct_abstention_judge')
    expect(out.finalSlide).toBeNull()
    expect(out.attempts.every((a) => !a.providerFailed)).toBe(true)
  })

  it('classifies an unanswerable query whose calls all 429 as INCONCLUSIVE, not a correct abstention', async () => {
    // THE BUG THIS FILE EXISTS FOR. Every generation call fails at the transport, no slide is
    // produced, and the old code read that as "the judge refused it" — so a fully
    // quota-blocked run reported 100% abstention accuracy, a score it would have earned with
    // the API key removed.
    const { fn } = scriptedClient([rateLimited()])
    const out = await evaluateQueryGeneration(unanswerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.abstentionClass).toBe('inconclusive')
    expect(out.abstentionClass).not.toBe('correct_abstention_judge')
    expect(out.attempts.every((a) => a.providerFailed)).toBe(true)
    expect(out.failureReason).toContain('429')
  })

  it('classifies an answerable query whose calls all 429 as INCONCLUSIVE, not a false abstention', async () => {
    const { fn } = scriptedClient([rateLimited()])
    const out = await evaluateQueryGeneration(answerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.abstentionClass).toBe('inconclusive')
    expect(out.grounded).toBe(false)
    expect(out.correct).toBe(false)
  })

  it('treats an UNREACHABLE judge as inconclusive even though the slide generated fine', async () => {
    // `verifySlide` fails closed on a provider error — correct for production, where an
    // unverified question must not reach a live room. The eval has to read `unavailable`
    // and not score it as a refusal.
    const { fn } = scriptedClient([slideOk(), rateLimited(), slideOk(), rateLimited()])
    const out = await evaluateQueryGeneration(unanswerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.abstentionClass).toBe('inconclusive')
    expect(out.attempts.every((a) => a.judgeVerdict?.unavailable === true || a.providerFailed)).toBe(true)
  })

  it('classifies a generated slide on an unanswerable query as unsupported generation', async () => {
    const { fn } = scriptedClient([slideOk(), judgeOk()])
    const out = await evaluateQueryGeneration(unanswerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.abstentionClass).toBe('unsupported_generation')
    expect(out.finalSlide).not.toBeNull()
  })

  it('retries once after a rejected first attempt and accepts the second', async () => {
    const { fn } = scriptedClient([slideOk(), judgeNo(), slideOk(), judgeOk()])
    const out = await evaluateQueryGeneration(answerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.attempts).toHaveLength(2)
    expect(out.attempts[0].success).toBe(false)
    expect(out.attempts[1].success).toBe(true)
    expect(out.abstentionClass).toBe('supported_generation')
  })

  it('stops at GEN_MAX_ATTEMPTS rather than retrying forever', async () => {
    const { fn } = scriptedClient([slideOk(), judgeNo(), slideOk(), judgeNo(), slideOk(), judgeOk()])
    const out = await evaluateQueryGeneration(answerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.attempts).toHaveLength(2)
    expect(out.finalSlide).toBeNull()
    expect(out.abstentionClass).toBe('false_abstention')
  })

  it('records a malformed payload as a schema failure, not a provider failure', async () => {
    const { fn } = scriptedClient([{ ok: true, input: { prompt: '', options: [] } }])
    const out = await evaluateQueryGeneration(answerable, doc, FULL_TEXT, evidence(), fn)

    expect(out.attempts[0].providerFailed).toBe(false)
    expect(out.attempts[0].schemaErrors.length).toBeGreaterThan(0)
    // A payload this pipeline rejected IS a decision, so it is a real abstention.
    expect(out.abstentionClass).toBe('false_abstention')
  })
})
