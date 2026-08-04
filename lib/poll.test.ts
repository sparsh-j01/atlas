import { describe, it, expect } from 'vitest'
import { blankPoll, toStoredPoll, validatePoll, type EditablePoll } from './poll'

// A valid baseline; each test perturbs one field.
function good(): EditablePoll {
  return {
    prompt: 'Which topic was hardest?',
    options: [
      { id: '1', text: 'Recursion' },
      { id: '2', text: 'Pointers' },
    ],
    timeLimitMs: 30_000,
    chart: 'bar',
  }
}

describe('validatePoll', () => {
  it('accepts a valid poll', () => {
    expect(validatePoll(good())).toEqual([])
  })

  // The shared option rules (lib/mcq validateOptionSlide) have to apply here too — this is
  // the half of validation a poll does NOT get to skip.
  it('rejects an empty prompt', () => {
    expect(validatePoll({ ...good(), prompt: '   ' })).toContain('Question prompt is required.')
  })

  it('rejects fewer than 2 options', () => {
    expect(validatePoll({ ...good(), options: [{ id: '1', text: 'Recursion' }] })).toContain(
      'Add at least 2 options.',
    )
  })

  it('rejects more than 6 options', () => {
    const options = Array.from({ length: 7 }, (_, i) => ({ id: String(i), text: `o${i}` }))
    expect(validatePoll({ ...good(), options })).toContain('No more than 6 options.')
  })

  it('rejects an empty option', () => {
    expect(
      validatePoll({ ...good(), options: [{ id: '1', text: 'Recursion' }, { id: '2', text: ' ' }] }),
    ).toContain('Every option needs text.')
  })

  it('rejects duplicate options (case/space-insensitive)', () => {
    expect(
      validatePoll({
        ...good(),
        options: [{ id: '1', text: 'Recursion' }, { id: '2', text: ' recursion ' }],
      }),
    ).toContain('Options must be unique.')
  })

  it('rejects an out-of-range time limit', () => {
    expect(validatePoll({ ...good(), timeLimitMs: 1_000 }).some((e) => e.includes('Time limit'))).toBe(
      true,
    )
  })

  it('rejects an unknown chart kind', () => {
    // Would otherwise fall through to a blank result view mid-session.
    expect(validatePoll({ ...good(), chart: 'sunburst' as never })).toContain('Pick a chart type.')
  })

  // The point of the type: a poll has no right answer, so none of the MCQ scoring rules fire.
  it('never asks for a correct option or points', () => {
    const errs = validatePoll(good())
    expect(errs).toEqual([])
    expect(JSON.stringify(errs)).not.toContain('correct')
    expect(JSON.stringify(errs)).not.toContain('Points')
  })

  it('blankPoll starts valid-shaped but empty (needs prompt + text)', () => {
    const errs = validatePoll(blankPoll())
    expect(errs).toContain('Question prompt is required.')
    expect(errs).toContain('Every option needs text.')
    // Two distinct option ids, so the pair isn't reported as duplicates before they're typed.
    expect(new Set(blankPoll().options.map((o) => o.id)).size).toBe(2)
  })
})

describe('toStoredPoll', () => {
  it('trims the prompt and every option', () => {
    const stored = toStoredPoll({
      ...good(),
      prompt: '  Which topic was hardest?  ',
      options: [
        { id: '1', text: '  Recursion  ' },
        { id: '2', text: 'Pointers ' },
      ],
    })
    expect(stored.prompt).toBe('Which topic was hardest?')
    expect(stored.config.options).toEqual([
      { id: '1', text: 'Recursion' },
      { id: '2', text: 'Pointers' },
    ])
  })

  it('stores no answer key of any kind', () => {
    // The whole anti-cheat surface for a poll: there is nothing to leak because nothing is
    // written. If is_correct ever appears here, sanitizeOptions is no longer the only guard.
    expect(JSON.stringify(toStoredPoll(good()).config)).not.toContain('is_correct')
  })
})
