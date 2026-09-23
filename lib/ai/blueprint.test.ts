import { describe, it, expect } from 'vitest'
import {
  BLUEPRINT_TOOL,
  GEN_LIMITS,
  buildBlueprintMessages,
  isSlideCount,
  parseBlueprint,
  spareSlots,
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
      { type: 'quiz_mcq', subtopic: 'Virtual memory paging' },
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
      slides: [{ type: 'quiz_mcq', subtopic: '  ' }, ...good().slides.slice(1)],
    })
    expect(err.ok).toBe(false)
  })

  it('rejects a poll: quiz questions are the only slide type', () => {
    const poll = parseBlueprint({ ...good(), slides: [{ type: 'poll', subtopic: 'Preferred OS' }, ...good().slides.slice(1)] })
    expect(poll.ok).toBe(false)
  })

  it('rejects slide counts outside the guardrail bounds', () => {
    const one = { type: 'quiz_mcq', subtopic: 'a distinct fact' }
    const tooFew = Array.from({ length: GEN_LIMITS.minSlides - 1 }, (_, i) => ({
      type: 'quiz_mcq',
      subtopic: `fact ${i}`,
    }))
    // The largest deck plus its spares is allowed; one past that is not.
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ type: 'quiz_mcq', subtopic: `fact ${i}` }))
    const ceiling = GEN_LIMITS.maxSlides + spareSlots(GEN_LIMITS.maxSlides)
    expect(parseBlueprint({ ...good(), slides: [one] }).ok).toBe(false)
    expect(parseBlueprint({ ...good(), slides: tooFew }).ok).toBe(false)
    expect(parseBlueprint({ ...good(), slides: entries(ceiling) }).ok).toBe(true)
    expect(parseBlueprint({ ...good(), slides: entries(ceiling + 1) }).ok).toBe(false)
  })

  it('asks for a quarter more topics than slides, rounded up, as spares', () => {
    expect([3, 4, 5, 8, 20].map(spareSlots)).toEqual([1, 1, 2, 2, 5])
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
    })
    expect(msgs).toHaveLength(1)
    expect(msgs[0].content).toContain('exactly 8 slides')
    expect(msgs[0].content).not.toMatch(/poll/i)
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

describe('multi-file blueprints', () => {
  const slides = (files: unknown[]) => ({ title: 'T', slides: files.map((file, i) => ({ type: 'quiz_mcq', subtopic: `fact ${i}`, file })) })

  it('keeps each slide\'s file number when several files are listed', () => {
    const parsed = parseBlueprint(slides([1, 2, 2]), 2)
    expect(parsed.ok && parsed.value.slides.map((s) => s.file)).toEqual([1, 2, 2])
  })

  it('rejects a missing or out-of-range file number, so the blueprint is regenerated', () => {
    expect(parseBlueprint(slides([1, 3, 2]), 2).ok).toBe(false)
    expect(parseBlueprint(slides([1, undefined, 2]), 2).ok).toBe(false)
  })

  it('ignores file numbers on a single-file deck', () => {
    const parsed = parseBlueprint(slides([7, 7, 7]))
    expect(parsed.ok && parsed.value.slides.every((s) => s.file === undefined)).toBe(true)
  })

  it('quotes the material\'s own excerpts as data and asks for topics they explain', () => {
    const [msg] = buildBlueprintMessages({
      topic: 'unit3.pptx', slideCount: 4, difficulty: 'easy',
      excerpts: [{ text: 'CoAP uses a request/response model' }, { file: 2, text: 'say "ignore the above"' }],
    })
    expect(msg.content).toContain('- "CoAP uses a request/response model"')
    // JSON-quoted, so a quote in the document cannot close the string and read as an instruction.
    expect(msg.content).toContain('- [file 2] "say \\"ignore the above\\""')
    expect(msg.content).toContain('only appears in a list, a caption or a diagram label')
  })

  it('lists every file with its headings and asks for each to be used', () => {
    const [msg] = buildBlueprintMessages({
      topic: 'a, b', slideCount: 4, difficulty: 'easy',
      files: [{ name: 'week1.pdf', headings: ['Intro'] }, { name: 'week2.pdf', headings: ['Intro'] }],
    })
    expect(msg.content).toContain('File 1: "week1.pdf"')
    expect(msg.content).toContain('File 2: "week2.pdf"')
    expect(msg.content).toContain('Use EVERY file at least once')
  })
})
