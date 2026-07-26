import { describe, it, expect } from 'vitest'
import {
  blankMcq,
  correctOptionId,
  EXPLANATION_MAX,
  isValidOptionId,
  sanitizeOptions,
  toStored,
  validateMcq,
  type EditableMcq,
  type McqConfig,
} from './mcq'

// A valid baseline; each test perturbs one field.
function good(): EditableMcq {
  return {
    prompt: 'Capital of France?',
    options: [
      { id: '1', text: 'Paris', is_correct: true },
      { id: '2', text: 'London', is_correct: false },
    ],
    timeLimitMs: 20_000,
    points: 1_000,
  }
}

describe('validateMcq', () => {
  it('accepts a valid MCQ', () => {
    expect(validateMcq(good())).toEqual([])
  })

  it('rejects an empty prompt', () => {
    expect(validateMcq({ ...good(), prompt: '   ' })).toContain('Question prompt is required.')
  })

  it('rejects fewer than 2 options', () => {
    expect(validateMcq({ ...good(), options: [{ id: '1', text: 'Paris', is_correct: true }] }))
      .toContain('Add at least 2 options.')
  })

  it('rejects more than 6 options', () => {
    const options = Array.from({ length: 7 }, (_, i) => ({ id: String(i), text: `o${i}`, is_correct: i === 0 }))
    expect(validateMcq({ ...good(), options })).toContain('No more than 6 options.')
  })

  it('rejects an empty option', () => {
    expect(validateMcq({ ...good(), options: [
      { id: '1', text: 'Paris', is_correct: true },
      { id: '2', text: '  ', is_correct: false },
    ] })).toContain('Every option needs text.')
  })

  it('rejects duplicate options (case/space-insensitive)', () => {
    expect(validateMcq({ ...good(), options: [
      { id: '1', text: 'Paris', is_correct: true },
      { id: '2', text: ' paris ', is_correct: false },
    ] })).toContain('Options must be unique.')
  })

  it('rejects zero correct options', () => {
    expect(validateMcq({ ...good(), options: good().options.map((o) => ({ ...o, is_correct: false })) }))
      .toContain('Mark exactly one option correct.')
  })

  it('rejects more than one correct option', () => {
    expect(validateMcq({ ...good(), options: good().options.map((o) => ({ ...o, is_correct: true })) }))
      .toContain('Mark exactly one option correct.')
  })

  it('rejects an out-of-range time limit', () => {
    expect(validateMcq({ ...good(), timeLimitMs: 1_000 }).some((e) => e.includes('Time limit'))).toBe(true)
  })

  it('rejects out-of-range points', () => {
    expect(validateMcq({ ...good(), points: 99_999 }).some((e) => e.includes('Points'))).toBe(true)
  })

  it('blankMcq starts valid-shaped but empty (needs prompt + text)', () => {
    // Two options, exactly one correct — but prompts/texts empty, so it is not yet valid.
    const errs = validateMcq(blankMcq())
    expect(errs).toContain('Question prompt is required.')
    expect(errs).toContain('Every option needs text.')
    expect(errs).not.toContain('Mark exactly one option correct.')
  })
})

describe('explanation (optional, shown after the reveal)', () => {
  it('accepts a slide with no explanation at all', () => {
    expect(validateMcq(good())).toEqual([])
    expect(validateMcq({ ...good(), explanation: '' })).toEqual([])
  })

  it('rejects one longer than the cap', () => {
    const errs = validateMcq({ ...good(), explanation: 'x'.repeat(EXPLANATION_MAX + 1) })
    expect(errs.some((e) => e.includes('Explanation'))).toBe(true)
    expect(validateMcq({ ...good(), explanation: 'x'.repeat(EXPLANATION_MAX) })).toEqual([])
  })

  it('is trimmed when kept and omitted entirely when blank', () => {
    // A blank explanation must not persist as "" — the reveal renders an empty box for it.
    expect(toStored({ ...good(), explanation: '   ' }).config).not.toHaveProperty('explanation')
    expect(toStored(good()).config).not.toHaveProperty('explanation')
    expect(toStored({ ...good(), explanation: '  Paris is the capital.  ' }).config.explanation).toBe(
      'Paris is the capital.',
    )
  })
})

// The live-session view of a saved config. sanitizeOptions is the anti-cheat boundary:
// every option list a participant receives before the reveal is built by it.
describe('live-session views of a saved config', () => {
  const config = (): McqConfig => ({
    options: [
      { id: '1', text: 'Paris', is_correct: true },
      { id: '2', text: 'London', is_correct: false },
    ],
    timeLimitMs: 20_000,
    points: 1_000,
  })

  it('sanitizeOptions never leaks the answer key', () => {
    const out = sanitizeOptions(config())
    expect(out).toEqual([
      { id: '1', text: 'Paris' },
      { id: '2', text: 'London' },
    ])
    // Belt and braces: no serialized form of the output may carry is_correct.
    expect(JSON.stringify(out)).not.toContain('is_correct')
  })

  it('correctOptionId finds the marked option, null when none is marked', () => {
    expect(correctOptionId(config())).toBe('1')
    const none = config()
    none.options = none.options.map((o) => ({ ...o, is_correct: false }))
    expect(correctOptionId(none)).toBeNull()
  })

  it('isValidOptionId accepts only this slide’s ids — untrusted input never gets through', () => {
    expect(isValidOptionId(config(), '2')).toBe(true)
    expect(isValidOptionId(config(), '99')).toBe(false)
    // An answer aimed at another slide, or junk from a hand-rolled request.
    for (const junk of [null, undefined, 1, {}, [], true, '']) {
      expect(isValidOptionId(config(), junk)).toBe(false)
    }
  })
})
