import { describe, it, expect } from 'vitest'
import { SLIDE_TOOL, buildSlideMessages, generatedToEditable } from './slide'
import { MCQ_DEFAULTS, TIME_MAX_MS, TIME_MIN_MS } from '../mcq'
import { POLL_DEFAULTS, validatePoll } from '../poll'
import { validateMcq } from '../mcq'

// Raw model output for one quiz question — structurally fine.
function goodQuiz() {
  return {
    prompt: 'Which data structure gives O(1) average lookup?',
    options: [
      { text: 'Hash table', is_correct: true },
      { text: 'Linked list', is_correct: false },
      { text: 'Stack', is_correct: false },
    ],
    explanation: 'Hash tables average constant time by key.',
    time_limit_ms: 25_000,
    points: 1000,
  }
}

describe('generatedToEditable — quiz', () => {
  const draft = () => generatedToEditable(goodQuiz(), { type: 'quiz_mcq' })

  it('converts to a valid editor draft with fresh option ids', () => {
    const d = draft()
    expect(d).not.toBeNull()
    if (!d || d.type !== 'quiz_mcq') return
    expect(d.prompt).toBe('Which data structure gives O(1) average lookup?')
    expect(d.options.map((o) => o.text)).toEqual(['Hash table', 'Linked list', 'Stack'])
    expect(d.options.filter((o) => o.is_correct)).toHaveLength(1)
    // ids are assigned server-side; they must exist and be distinct
    expect(new Set(d.options.map((o) => o.id)).size).toBe(3)
    expect(validateMcq(d)).toEqual([])
  })

  it('keeps a poll option shape free of is_correct', () => {
    const d = generatedToEditable(
      { prompt: 'Favorite language?', options: [{ text: 'Rust' }, { text: 'Go' }] },
      { type: 'poll' },
    )
    expect(d).not.toBeNull()
    if (!d || d.type !== 'poll') return
    expect(Object.keys(d.options[0])).toEqual(['id', 'text'])
    expect(validatePoll(d)).toEqual([])
  })

  it('coerces out-of-range or missing time/points to defaults (presentation knobs)', () => {
    const d = generatedToEditable(
      { ...goodQuiz(), time_limit_ms: 999, points: undefined },
      { type: 'quiz_mcq' },
    )
    if (!d || d.type !== 'quiz_mcq') return expect(d).not.toBeNull()
    expect(d.timeLimitMs).toBe(MCQ_DEFAULTS.timeLimitMs)
    expect(d.points).toBe(MCQ_DEFAULTS.points)
  })

  it('accepts an in-range custom time limit', () => {
    const d = generatedToEditable({ ...goodQuiz(), time_limit_ms: TIME_MIN_MS }, { type: 'quiz_mcq' })
    if (!d || d.type !== 'quiz_mcq') return expect(d).not.toBeNull()
    expect(d.timeLimitMs).toBe(TIME_MIN_MS)
    expect(TIME_MAX_MS).toBeGreaterThan(TIME_MIN_MS) // bounds sanity
  })

  it('drops an over-budget explanation instead of truncating mid-sentence', () => {
    const d = generatedToEditable({ ...goodQuiz(), explanation: 'x'.repeat(501) }, { type: 'quiz_mcq' })
    if (!d || d.type !== 'quiz_mcq') return expect(d).not.toBeNull()
    expect(d.explanation).toBeUndefined()
  })

  it('treats a missing is_correct as not-correct (semantic check happens later)', () => {
    const raw = goodQuiz() as Record<string, unknown>
    const options = (raw.options as { text: string; is_correct?: boolean }[]).map((o) => ({
      text: o.text,
    }))
    const d = generatedToEditable({ ...raw, options }, { type: 'quiz_mcq' })
    if (!d || d.type !== 'quiz_mcq') return expect(d).not.toBeNull()
    // Structurally accepted — but ZERO correct answers must fail the deck validators.
    expect(validateMcq(d)).toContain('Mark exactly one option correct.')
  })

  it('returns null on structural garbage', () => {
    expect(generatedToEditable(null, { type: 'quiz_mcq' })).toBeNull()
    expect(generatedToEditable({}, { type: 'quiz_mcq' })).toBeNull()
    expect(generatedToEditable({ ...goodQuiz(), prompt: '' }, { type: 'quiz_mcq' })).toBeNull()
    expect(generatedToEditable({ ...goodQuiz(), options: [] }, { type: 'quiz_mcq' })).toBeNull()
    expect(
      generatedToEditable(
        { ...goodQuiz(), options: [{ text: 'only one' }] },
        { type: 'quiz_mcq' },
      ),
    ).toBeNull()
    expect(
      generatedToEditable(
        { ...goodQuiz(), options: [{ text: 'a' }, { text: '' }] },
        { type: 'quiz_mcq' },
      ),
    ).toBeNull()
    expect(
      generatedToEditable(
        { ...goodQuiz(), options: [{ text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }, { text: 'f' }, { text: 'g' }] },
        { type: 'quiz_mcq' },
      ),
    ).toBeNull()
  })
})

describe('generatedToEditable — poll', () => {
  it('defaults an unknown chart kind to bar', () => {
    const d = generatedToEditable(
      { prompt: 'Remote or office?', options: [{ text: 'Remote' }, { text: 'Office' }], chart: 'hologram' },
      { type: 'poll' },
    )
    if (!d || d.type !== 'poll') return expect(d).not.toBeNull()
    expect(d.chart).toBe(POLL_DEFAULTS.chart)
  })

  it('rejects structural garbage like the quiz path', () => {
    expect(generatedToEditable({ prompt: 'p', options: [{ text: 'a' }] }, { type: 'poll' })).toBeNull()
  })
})

describe('slide tool contract', () => {
  it('names the subtopic in the prompt so grounding is traceable per call', () => {
    const [msg] = buildSlideMessages(
      { topic: 'Operating systems', difficulty: 'hard' },
      { type: 'quiz_mcq', subtopic: 'Deadlock conditions' },
    )
    expect(msg.content).toContain('Deadlock conditions')
    expect(msg.content).toContain('quiz_mcq')
  })

  it('exposes required tool fields', () => {
    expect(SLIDE_TOOL.name).toBe('emit_slide')
    expect(SLIDE_TOOL.inputSchema.required).toEqual(['prompt', 'options'])
  })
})
