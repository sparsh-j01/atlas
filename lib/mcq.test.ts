import { describe, it, expect } from 'vitest'
import { validateMcq, blankMcq, type EditableMcq } from './mcq'

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
