import { describe, it, expect } from 'vitest'
import { correctOptionId, isValidOptionId, sanitizeOptions, type McqConfig } from './mcq'
import type { PollConfig } from './poll'
import {
  blankSlide,
  explanationOf,
  isScored,
  isSlideType,
  pointsOf,
  toEditable,
  toStoredSlide,
  validateSlide,
  type EditableSlide,
} from './slides'

const mcqConfig = (): McqConfig => ({
  options: [
    { id: '1', text: 'Paris', is_correct: true },
    { id: '2', text: 'London', is_correct: false },
  ],
  timeLimitMs: 20_000,
  points: 1_000,
  explanation: 'Paris is the capital.',
})

const pollConfig = (): PollConfig => ({
  options: [
    { id: 'a', text: 'Recursion' },
    { id: 'b', text: 'Pointers' },
  ],
  timeLimitMs: 30_000,
  chart: 'donut',
})

describe('isScored', () => {
  it('is true only for the quiz type', () => {
    expect(isScored('quiz_mcq')).toBe(true)
    expect(isScored('poll')).toBe(false)
  })

  // This predicate decides whether a running tally may be broadcast while the window is open.
  // An unknown type has to fall to "unscored" — which is the side that leaks nothing, because
  // an unscored slide has no answer key to protect in the first place.
  it('fails safe on an unrecognised type', () => {
    for (const t of ['word_cloud', 'scale', '', 'QUIZ_MCQ']) expect(isScored(t)).toBe(false)
  })
})

describe('pointsOf / explanationOf', () => {
  it('reads MCQ points and returns 0 for a type that has none', () => {
    expect(pointsOf(mcqConfig())).toBe(1_000)
    expect(pointsOf(pollConfig())).toBe(0)
  })

  it('reads the explanation only where one can exist', () => {
    expect(explanationOf(mcqConfig())).toBe('Paris is the capital.')
    // Key genuinely absent, which is what toStored writes for a blank explanation — so `in`
    // is the honest check rather than a truthiness test on a property that may not exist.
    const noExplanation: McqConfig = {
      options: mcqConfig().options,
      timeLimitMs: 20_000,
      points: 1_000,
    }
    expect(explanationOf(noExplanation)).toBeUndefined()
    expect(explanationOf(pollConfig())).toBeUndefined()
  })
})

// The live-session views are typed structurally so one implementation serves every
// option-based type. These are the anti-cheat helpers, so "works on a poll" has to be proven,
// not assumed from the fact that it compiles.
describe('live-session views accept a poll config', () => {
  it('sanitizeOptions strips to id + text', () => {
    expect(sanitizeOptions(pollConfig())).toEqual([
      { id: 'a', text: 'Recursion' },
      { id: 'b', text: 'Pointers' },
    ])
  })

  it('correctOptionId is null for a poll — nothing to disclose at reveal', () => {
    expect(correctOptionId(pollConfig())).toBeNull()
    expect(correctOptionId(mcqConfig())).toBe('1')
  })

  it('isValidOptionId still rejects anything not on the slide', () => {
    expect(isValidOptionId(pollConfig(), 'a')).toBe(true)
    expect(isValidOptionId(pollConfig(), '1')).toBe(false) // an id from the MCQ above
    for (const junk of [null, undefined, 1, {}, [], true, '']) {
      expect(isValidOptionId(pollConfig(), junk)).toBe(false)
    }
  })
})

describe('per-type dispatch', () => {
  it('isSlideType accepts only the known set', () => {
    expect(isSlideType('quiz_mcq')).toBe(true)
    expect(isSlideType('poll')).toBe(true)
    for (const junk of ['word_cloud', '', null, 7, {}]) expect(isSlideType(junk)).toBe(false)
  })

  it('blankSlide tags the draft with its own type', () => {
    expect(blankSlide('quiz_mcq').type).toBe('quiz_mcq')
    expect(blankSlide('poll').type).toBe('poll')
  })

  // The wire that must not cross: a poll draft validated by the MCQ rules would demand a
  // correct option that a poll can never have, and an MCQ validated as a poll would skip the
  // answer-key check entirely and let a broken question reach a live room.
  it('validateSlide picks the rules matching the draft', () => {
    const poll: EditableSlide = {
      type: 'poll',
      prompt: 'Which topic was hardest?',
      options: [
        { id: 'a', text: 'Recursion' },
        { id: 'b', text: 'Pointers' },
      ],
      timeLimitMs: 30_000,
      chart: 'bar',
    }
    expect(validateSlide(poll)).toEqual([])

    const mcqMissingKey: EditableSlide = {
      type: 'quiz_mcq',
      prompt: 'Capital of France?',
      options: [
        { id: '1', text: 'Paris', is_correct: false },
        { id: '2', text: 'London', is_correct: false },
      ],
      timeLimitMs: 20_000,
      points: 1_000,
    }
    expect(validateSlide(mcqMissingKey)).toContain('Mark exactly one option correct.')
  })

  it('toStoredSlide writes the config shape for the draft type', () => {
    const stored = toStoredSlide({ type: 'poll', prompt: ' p ', ...pollConfig() })
    expect(stored.config).toMatchObject({ chart: 'donut', timeLimitMs: 30_000 })
    expect(stored.config).not.toHaveProperty('points')
    expect(stored.prompt).toBe('p')
  })
})

describe('toEditable — the type/config trust boundary', () => {
  it('round-trips a row whose type and config agree', () => {
    expect(toEditable({ type: 'poll', prompt: 'p', config: pollConfig() })).toMatchObject({
      type: 'poll',
      chart: 'donut',
    })
    expect(toEditable({ type: 'quiz_mcq', prompt: 'q', config: mcqConfig() })).toMatchObject({
      type: 'quiz_mcq',
      points: 1_000,
    })
  })

  // Nothing in the database enforces the pairing — `type` is text and `config` is jsonb — so
  // a mismatch is reachable by a migration, a hand-run statement, or M6's generator. It has
  // to fail closed: the deck ready-gate calls this, and a null is what keeps the slide out of
  // a live room instead of crashing mid-game on a missing field.
  it('returns null when type and config disagree', () => {
    expect(toEditable({ type: 'quiz_mcq', prompt: 'p', config: pollConfig() })).toBeNull()
    expect(toEditable({ type: 'poll', prompt: 'p', config: mcqConfig() })).toBeNull()
  })

  it('returns null for a type this build does not know', () => {
    expect(toEditable({ type: 'word_cloud', prompt: 'p', config: pollConfig() })).toBeNull()
    expect(toEditable({ type: '', prompt: 'p', config: mcqConfig() })).toBeNull()
  })
})
