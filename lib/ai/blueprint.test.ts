import { describe, it, expect } from 'vitest'
import {
  BLUEPRINT_TOOL,
  GEN_LIMITS,
  buildBlueprintMessages,
  isSlideCount,
  parseBlueprint,
} from './blueprint'
import { SYSTEM_PROMPT } from './prompt'

// A valid baseline; each test perturbs one field.
function good() {
  return {
    title: 'Operating Systems',
    description: 'Processes, scheduling and memory.',
    difficulty: 'medium',
    slides: [
      { type: 'quiz_mcq', subtopic: 'What a process is' },
      { type: 'quiz_mcq', subtopic: 'Round-robin scheduling' },
      { type: 'poll', subtopic: 'Preferred OS' },
    ],
  }
}

describe('parseBlueprint', () => {
  it('accepts a valid blueprint and normalizes fields', () => {
    const parsed = parseBlueprint(good())
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.title).toBe('Operating Systems')
    expect(parsed.value.difficulty).toBe('medium')
    expect(parsed.value.slides).toHaveLength(3)
    expect(parsed.value.description).toBe('Processes, scheduling and memory.')
  })

  it('rejects non-object input', () => {
    expect(parseBlueprint(null).ok).toBe(false)
    expect(parseBlueprint('nope').ok).toBe(false)
  })

  it('rejects a missing or empty title', () => {
    expect(parseBlueprint({ ...good(), title: '' }).ok).toBe(false)
    expect(parseBlueprint({ ...good(), title: '   ' }).ok).toBe(false)
    expect(parseBlueprint({ ...good(), title: undefined }).ok).toBe(false)
  })

  it('rejects an over-long title rather than truncating silently', () => {
    const err = parseBlueprint({ ...good(), title: 'x'.repeat(200) })
    expect(err.ok).toBe(false)
    // @ts-expect-error narrowing for the assertion
    expect(err.errors.join(' ')).toMatch(/title/)
  })

  it('coerces a missing or invalid difficulty to medium (metadata, not content)', () => {
    const missing = parseBlueprint({ ...good(), difficulty: undefined })
    expect(missing.ok).toBe(true)
    if (missing.ok) expect(missing.value.difficulty).toBe('medium')

    const invalid = parseBlueprint({ ...good(), difficulty: 'impossible' })
    expect(invalid.ok).toBe(true)
    if (invalid.ok) expect(invalid.value.difficulty).toBe('medium')
  })

  it('omits the description when blank', () => {
    const parsed = parseBlueprint({ ...good(), description: '   ' })
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.value.description).toBeUndefined()
  })

  it('rejects unknown slide types, naming the entry', () => {
    const err = parseBlueprint({
      ...good(),
      slides: [...good().slides.slice(0, 2), { type: 'word_cloud', subtopic: 'anything' }],
    })
    expect(err.ok).toBe(false)
    // @ts-expect-error narrowing for the assertion
    expect(err.errors[0]).toMatch(/slide 3/)
  })

  it('rejects empty subtopics', () => {
    const err = parseBlueprint({
      ...good(),
      slides: [{ type: 'poll', subtopic: '  ' }, ...good().slides.slice(1)],
    })
    expect(err.ok).toBe(false)
  })

  it('rejects slide counts outside the guardrail bounds', () => {
    const one = { type: 'quiz_mcq', subtopic: 'a distinct fact' }
    const tooFew = Array.from({ length: GEN_LIMITS.minSlides - 1 }, (_, i) => ({
      type: 'quiz_mcq',
      subtopic: `fact ${i}`,
    }))
    const tooMany = Array.from({ length: GEN_LIMITS.maxSlides + 1 }, (_, i) => ({
      type: 'quiz_mcq',
      subtopic: `fact ${i}`,
    }))
    expect(parseBlueprint({ ...good(), slides: [one] }).ok).toBe(false)
    expect(parseBlueprint({ ...good(), slides: tooFew }).ok).toBe(false)
    expect(parseBlueprint({ ...good(), slides: tooMany }).ok).toBe(false)
  })
})

describe('blueprint inputs + tool contract', () => {
  it('isSlideCount enforces the guardrail bounds as integers', () => {
    expect(isSlideCount(GEN_LIMITS.minSlides)).toBe(true)
    expect(isSlideCount(GEN_LIMITS.maxSlides)).toBe(true)
    expect(isSlideCount(GEN_LIMITS.minSlides - 1)).toBe(false)
    expect(isSlideCount(GEN_LIMITS.maxSlides + 1)).toBe(false)
    expect(isSlideCount(7.5)).toBe(false)
    expect(isSlideCount('8')).toBe(false)
  })

  it('the prompt names the exact slide count so "exactly N" is checkable downstream', () => {
    const msgs = buildBlueprintMessages({
      topic: 'The water cycle',
      slideCount: 8,
      difficulty: 'easy',
      includePolls: true,
    })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('exactly 8 slides')
    expect(msgs[0].content).toContain('every fourth slide a poll')
  })

  it('without polls, every slide is announced as a quiz question', () => {
    const [msg] = buildBlueprintMessages({
      topic: 't',
      slideCount: 5,
      difficulty: 'hard',
      includePolls: false,
    })
    expect(msg.content).toContain('Every slide is a quiz question')
  })

  it('tool spec forces structured output with required fields', () => {
    expect(BLUEPRINT_TOOL.name).toBe('emit_blueprint')
    expect(BLUEPRINT_TOOL.inputSchema.required).toEqual(['title', 'slides'])
  })

  it('system prompt is shared and stable — the cache key for every call in a run', () => {
    expect(typeof SYSTEM_PROMPT).toBe('string')
    expect(SYSTEM_PROMPT).toMatch(/EXACTLY ONE correct option/)
  })
})
