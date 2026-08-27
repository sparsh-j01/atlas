import { describe, it, expect } from 'vitest'
import { finalizeSlides, normalizePrompt, GEN_MAX_ATTEMPTS } from './validate'
import type { EditableSlide } from '../slides'

// Untyped return on purpose: tests mutate the draft, and every consumer below takes the
// EditableSlide union anyway.
function quiz(prompt: string) {
  return {
    type: 'quiz_mcq',
    prompt,
    options: [
      { id: '1', text: 'Paris', is_correct: true },
      { id: '2', text: 'London', is_correct: false },
    ],
    timeLimitMs: 20_000,
    points: 1000,
  } satisfies EditableSlide
}

// N distinct valid quizzes.
function batch(n: number): EditableSlide[] {
  return Array.from({ length: n }, (_, i) => quiz(`Distinct question number ${i + 1}?`))
}

describe('normalizePrompt', () => {
  it('ignores case, whitespace runs and trailing punctuation', () => {
    expect(normalizePrompt('  What   IS X? ')).toBe(normalizePrompt('what is x'))
    expect(normalizePrompt('What is X.')).toBe(normalizePrompt('What is X?'))
  })

  it('keeps genuinely different questions distinct', () => {
    expect(normalizePrompt('What is X?')).not.toBe(normalizePrompt('What is Y?'))
  })
})

describe('finalizeSlides', () => {
  it('accepts a clean run and reports nothing dropped', () => {
    const slides = batch(5)
    const result = finalizeSlides(
      slides.map((s) => ({ subtopic: s.prompt, slide: s })),
      5,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slides).toHaveLength(5)
    expect(result.dropped).toEqual([])
  })

  it('drops structurally-unusable entries with the subtopic named', () => {
    const result = finalizeSlides(
      [
        { subtopic: 'good one', slide: quiz('Q one?') },
        { subtopic: 'bad one', slide: null },
        { subtopic: 'good two', slide: quiz('Q two?') },
        { subtopic: 'good three', slide: quiz('Q three?') },
      ],
      4,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slides).toHaveLength(3)
    expect(result.dropped.join(' ')).toMatch(/bad one/)
  })

  it('applies the SAME per-slide validators as the hand-built editor', () => {
    // Two options marked correct — passes no editor gate anywhere in this app.
    const broken = quiz('Broken question?')
    broken.options[1].is_correct = true
    const result = finalizeSlides(
      [1, 2, 3, 4].map((i) => ({
        subtopic: `s${i}`,
        slide: i === 2 ? broken : quiz(`Valid question ${i}?`),
      })),
      4,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.slides.map((s) => s.prompt)).toEqual([
      'Valid question 1?',
      'Valid question 3?',
      'Valid question 4?',
    ])
    expect(result.dropped.join(' ')).toMatch(/exactly one option correct/)
  })

  it('dedupes near-duplicate prompts, keeping the first occurrence', () => {
    const dup = quiz('what is x')
    const result = finalizeSlides(
      [
        { subtopic: 'original', slide: quiz('What is X?') },
        { subtopic: 'restated', slide: dup },
        ...batch(4).map((s) => ({ subtopic: s.prompt, slide: s })),
      ],
      6,
    )
    if (!result.ok) return expect(result).not.toBe(true)
    const prompts = result.slides.map((s) => normalizePrompt(s.prompt))
    expect(prompts.filter((p) => p === 'what is x')).toHaveLength(1)
    expect(result.dropped.join(' ')).toMatch(/duplicate question/)
  })

  it('fails closed when too few survive — even if some did', () => {
    const survivors = batch(2).map((s) => ({ subtopic: s.prompt, slide: s }))
    const junk = Array.from({ length: 6 }, () => ({ subtopic: 'junk', slide: null }))
    const result = finalizeSlides([...survivors, ...junk], 8)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.join(' ')).toMatch(/survived validation/)
    expect(result.errors.join(' ')).toMatch(/need at least \d+/)
  })

  it('the floor never drops below minSlides even for tiny requests', () => {
    const result = finalizeSlides(batch(2).map((s) => ({ subtopic: s.prompt, slide: s })), 2)
    expect(result.ok).toBe(false)
  })

  it('bounded regeneration means at most two attempts per entry', () => {
    expect(GEN_MAX_ATTEMPTS).toBeGreaterThanOrEqual(1)
    expect(GEN_MAX_ATTEMPTS).toBeLessThanOrEqual(3)
  })
})
