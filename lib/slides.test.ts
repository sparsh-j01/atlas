import { describe, it, expect } from 'vitest'
import { correctOptionId, isValidOptionId, sanitizeOptions, type McqConfig } from './mcq'
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
  type SlideConfig,
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

// What a poll row looked like before polls were removed (2026-10-05): no is_correct, no
// points. One of these left in the database must fail closed, never reach a live room.
const legacyPollConfig = {
  options: [
    { id: 'a', text: 'Recursion' },
    { id: 'b', text: 'Pointers' },
  ],
  timeLimitMs: 30_000,
  chart: 'donut',
} as unknown as SlideConfig

describe('isScored', () => {
  it('is true only for the quiz type', () => {
    expect(isScored('quiz_mcq')).toBe(true)
  })

  // An unknown type has to fall to "unscored" — the side that grades nothing against an
  // answer key it does not have.
  it('fails safe on an unrecognised type', () => {
    for (const t of ['poll', 'word_cloud', 'scale', '', 'QUIZ_MCQ']) expect(isScored(t)).toBe(false)
  })
})

describe('pointsOf / explanationOf', () => {
  it('reads MCQ points', () => {
    expect(pointsOf(mcqConfig())).toBe(1_000)
  })

  it('reads the explanation, and undefined when none was saved', () => {
    expect(explanationOf(mcqConfig())).toBe('Paris is the capital.')
    // Key genuinely absent, which is what toStored writes for a blank explanation.
    const noExplanation: McqConfig = {
      options: mcqConfig().options,
      timeLimitMs: 20_000,
      points: 1_000,
    }
    expect(explanationOf(noExplanation)).toBeUndefined()
  })
})

// The anti-cheat helpers: what a participant may see before the quiz ends.
describe('live-session views', () => {
  it('sanitizeOptions strips the answer key to id + text', () => {
    expect(sanitizeOptions(mcqConfig())).toEqual([
      { id: '1', text: 'Paris' },
      { id: '2', text: 'London' },
    ])
  })

  it('correctOptionId names the marked option', () => {
    expect(correctOptionId(mcqConfig())).toBe('1')
  })

  it('isValidOptionId rejects anything not on the slide', () => {
    expect(isValidOptionId(mcqConfig(), '1')).toBe(true)
    expect(isValidOptionId(mcqConfig(), 'a')).toBe(false)
    for (const junk of [null, undefined, 1, {}, [], true, '']) {
      expect(isValidOptionId(mcqConfig(), junk)).toBe(false)
    }
  })
})

describe('per-type dispatch', () => {
  it('isSlideType accepts only the quiz type', () => {
    expect(isSlideType('quiz_mcq')).toBe(true)
    // A stale editor tab or script still asking for a poll is refused at the action.
    for (const junk of ['poll', 'word_cloud', '', null, 7, {}]) expect(isSlideType(junk)).toBe(false)
  })

  it('blankSlide tags the draft with its own type', () => {
    expect(blankSlide('quiz_mcq').type).toBe('quiz_mcq')
  })

  it('validateSlide enforces the answer key and refuses NUL bytes', () => {
    const mcq: EditableSlide = { type: 'quiz_mcq', prompt: 'Capital of France?', ...mcqConfig() }
    expect(validateSlide(mcq)).toEqual([])
    // A NUL anywhere — prompt or a nested option — is a Postgres error on save, so it fails here.
    expect(validateSlide({ ...mcq, prompt: 'a\0b' })).toHaveLength(1)
    expect(validateSlide({ ...mcq, options: [mcq.options[0], { id: '2', text: 'x\0', is_correct: false }] })).toHaveLength(1)

    const missingKey: EditableSlide = {
      ...mcq,
      options: mcq.options.map((o) => ({ ...o, is_correct: false })),
    }
    expect(validateSlide(missingKey)).toContain('Mark exactly one option correct.')
  })

  it('toStoredSlide trims the prompt and keeps the MCQ config', () => {
    const stored = toStoredSlide({ type: 'quiz_mcq', prompt: ' p ', ...mcqConfig() })
    expect(stored.config).toMatchObject({ points: 1_000, timeLimitMs: 20_000 })
    expect(stored.prompt).toBe('p')
  })
})

describe('toEditable — the type/config trust boundary', () => {
  it('round-trips a quiz row', () => {
    expect(toEditable({ type: 'quiz_mcq', prompt: 'q', config: mcqConfig() })).toMatchObject({
      type: 'quiz_mcq',
      points: 1_000,
    })
  })

  // Nothing in the database enforces the pairing — `type` is text and `config` is jsonb. The
  // deck ready-gate calls this, and a null is what keeps the slide out of a live room.
  it('returns null for a leftover poll row, or a quiz type holding a poll config', () => {
    expect(toEditable({ type: 'poll', prompt: 'p', config: legacyPollConfig })).toBeNull()
    expect(toEditable({ type: 'quiz_mcq', prompt: 'p', config: legacyPollConfig })).toBeNull()
  })

  // validateSlide iterates `options`, so a config missing it would throw out of the
  // ready-gate rather than fail it.
  it('returns null when the config has no option list', () => {
    expect(toEditable({ type: 'quiz_mcq', prompt: 'q', config: { ...mcqConfig(), options: null as never } })).toBeNull()
  })

  it('returns null for a type this build does not know', () => {
    expect(toEditable({ type: 'word_cloud', prompt: 'p', config: mcqConfig() })).toBeNull()
    expect(toEditable({ type: '', prompt: 'p', config: mcqConfig() })).toBeNull()
  })
})
