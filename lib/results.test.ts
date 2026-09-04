import { describe, expect, it } from 'vitest'
import {
  csvCell,
  csvFilename,
  shapeResults,
  toGradebookCsv,
  type AnswerRow,
  type ParticipantRow,
  type SlideRow,
} from './results'
import type { McqConfig } from './mcq'
import type { PollConfig } from './poll'

const mcq = (opts: [string, string, boolean][]): McqConfig => ({
  options: opts.map(([id, text, is_correct]) => ({ id, text, is_correct })),
  timeLimitMs: 20_000,
  points: 1000,
})

const poll = (opts: [string, string][]): PollConfig => ({
  options: opts.map(([id, text]) => ({ id, text })),
  timeLimitMs: 30_000,
  chart: 'bar',
})

const quizSlide: SlideRow = {
  id: 's1',
  type: 'quiz_mcq',
  prompt: 'Which conditions cause deadlock?',
  position: 0,
  config: mcq([
    ['o1', 'All four Coffman conditions', true],
    ['o2', 'Only circular wait', false],
  ]),
}

const pollSlide: SlideRow = {
  id: 's2',
  type: 'poll',
  prompt: 'How was the pace?',
  position: 1,
  config: poll([
    ['p1', 'Too fast'],
    ['p2', 'Just right'],
  ]),
}

const people: ParticipantRow[] = [
  { participantId: 'b', nickname: 'Arjun', avatarSeed: 'b', score: 900 },
  { participantId: 'a', nickname: 'Priyanka', avatarSeed: 'a', score: 1800 },
]

const ans = (o: Partial<AnswerRow> & Pick<AnswerRow, 'slideId' | 'participantId' | 'optionId'>): AnswerRow => ({
  isCorrect: null,
  pointsAwarded: 0,
  responseMs: 3000,
  ...o,
})

describe('shapeResults', () => {
  it('tallies each option and counts correct answers on a scored slide', () => {
    const r = shapeResults([quizSlide], people, [
      ans({ slideId: 's1', participantId: 'a', optionId: 'o1', isCorrect: true, pointsAwarded: 900, responseMs: 2000 }),
      ans({ slideId: 's1', participantId: 'b', optionId: 'o2', isCorrect: false, responseMs: 4000 }),
    ])
    const q = r.questions[0]
    expect(q.scored).toBe(true)
    expect(q.answered).toBe(2)
    expect(q.correct).toBe(1)
    expect(q.avgResponseMs).toBe(3000)
    expect(q.options.map((o) => [o.id, o.count, o.isCorrect])).toEqual([
      ['o1', 1, true],
      ['o2', 1, false],
    ])
  })

  it('ranks by score descending, breaking ties on participantId like the live leaderboard', () => {
    const r = shapeResults([quizSlide], people, [])
    expect(r.participants.map((p) => [p.nickname, p.rank])).toEqual([
      ['Priyanka', 1],
      ['Arjun', 2],
    ])
  })

  it('breaks an exact score tie deterministically', () => {
    const tied: ParticipantRow[] = [
      { participantId: 'z', nickname: 'Zoya', avatarSeed: 'z', score: 500 },
      { participantId: 'a', nickname: 'Ali', avatarSeed: 'a', score: 500 },
    ]
    expect(shapeResults([], tied, []).participants.map((p) => p.nickname)).toEqual(['Ali', 'Zoya'])
  })

  it('does not score a poll, and reports no correct answers for it', () => {
    const r = shapeResults([pollSlide], people, [
      ans({ slideId: 's2', participantId: 'a', optionId: 'p1' }),
      ans({ slideId: 's2', participantId: 'b', optionId: 'p1' }),
    ])
    const q = r.questions[0]
    expect(q.scored).toBe(false)
    expect(q.correct).toBe(0)
    expect(q.options.find((o) => o.id === 'p1')!.count).toBe(2)
  })

  // The three consequences of answers.slide_id having no foreign key.
  it('keeps a deleted slide as a numbered question with no prompt', () => {
    const r = shapeResults([quizSlide], people, [
      ans({ slideId: 'gone', participantId: 'a', optionId: 'x' }),
      ans({ slideId: 's1', participantId: 'b', optionId: 'o1', isCorrect: true }),
    ])
    expect(r.questions.map((q) => [q.number, q.slideId, q.prompt])).toEqual([
      [1, 's1', 'Which conditions cause deadlock?'],
      [2, 'gone', null],
    ])
    expect(r.questions[1].answered).toBe(1)
  })

  it('counts an answer whose option was removed by a later edit, rather than dropping it', () => {
    const r = shapeResults([quizSlide], people, [
      ans({ slideId: 's1', participantId: 'a', optionId: 'deleted-option' }),
      ans({ slideId: 's1', participantId: 'b', optionId: 'o1', isCorrect: true }),
    ])
    const q = r.questions[0]
    expect(q.answered).toBe(2)
    expect(q.strayCount).toBe(1)
    // The surviving option's own count must not absorb the stray.
    expect(q.options.find((o) => o.id === 'o1')!.count).toBe(1)
    expect(q.options.reduce((n, o) => n + o.count, 0) + q.strayCount).toBe(q.answered)
  })

  it('survives the whole deck being deleted, keeping scores and answers', () => {
    const r = shapeResults([], people, [
      ans({ slideId: 's1', participantId: 'a', optionId: 'o1', pointsAwarded: 900 }),
    ])
    expect(r.deckDeleted).toBe(true)
    expect(r.questions).toHaveLength(1)
    expect(r.questions[0].prompt).toBeNull()
    expect(r.participants[0].score).toBe(1800)
  })

  it('skips a slide added after the session ran', () => {
    const added: SlideRow = { ...pollSlide, id: 's9', position: 5 }
    const r = shapeResults(
      [quizSlide, added],
      people,
      [ans({ slideId: 's1', participantId: 'a', optionId: 'o1' })],
      ['s1'],
    )
    expect(r.questions.map((q) => q.slideId)).toEqual(['s1'])
  })

  it('keeps a question that was revealed but that nobody answered', () => {
    const r = shapeResults([quizSlide, pollSlide], people, [], ['s1', 's2'])
    expect(r.questions.map((q) => [q.slideId, q.answered])).toEqual([
      ['s1', 0],
      ['s2', 0],
    ])
    expect(r.questions[0].avgResponseMs).toBeNull()
  })

  it('omits a slide the host skipped without revealing and nobody answered', () => {
    const r = shapeResults([quizSlide, pollSlide], people, [], ['s1'])
    expect(r.questions.map((q) => q.slideId)).toEqual(['s1'])
  })

  it('orders questions by deck position, not by answer arrival', () => {
    const r = shapeResults([pollSlide, quizSlide], people, [
      ans({ slideId: 's2', participantId: 'a', optionId: 'p1' }),
      ans({ slideId: 's1', participantId: 'a', optionId: 'o1' }),
    ])
    expect(r.questions.map((q) => q.slideId)).toEqual(['s1', 's2'])
  })

  it('leaves bySlide empty for a participant who never answered', () => {
    const r = shapeResults([quizSlide], people, [])
    expect(r.participants[0].bySlide).toEqual({})
    expect(r.participants[0].answered).toBe(0)
  })
})

describe('csvCell', () => {
  it('quotes fields containing a comma, quote or newline', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
  })

  it('leaves a plain field alone', () => {
    expect(csvCell('Priyanka')).toBe('Priyanka')
    expect(csvCell(1800)).toBe('1800')
  })

  it('renders null and undefined as empty', () => {
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  // The reason this function exists rather than a join(',').
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tx', '\rx'])(
    'defuses the spreadsheet formula %j that a nickname could carry',
    (evil) => {
      const out = csvCell(evil)
      expect(out.startsWith('"\'')).toBe(true)
    },
  )

  it('defuses a formula that also needs quoting', () => {
    expect(csvCell('=cmd|"/c calc"!A0')).toBe('"\'=cmd|""/c calc""!A0"')
  })
})

describe('toGradebookCsv', () => {
  const results = shapeResults([quizSlide, pollSlide], people, [
    ans({ slideId: 's1', participantId: 'a', optionId: 'o1', isCorrect: true, pointsAwarded: 900 }),
    ans({ slideId: 's2', participantId: 'a', optionId: 'p2' }),
    ans({ slideId: 's1', participantId: 'b', optionId: 'o2', isCorrect: false }),
  ])
  const lines = toGradebookCsv(results).split('\r\n')

  it('puts the question text in the column header', () => {
    expect(lines[0]).toContain('Q1: Which conditions cause deadlock?')
    expect(lines[0]).toContain('Q2: How was the pace?')
  })

  it('writes points for a scored question and the chosen option for a poll', () => {
    expect(lines[1]).toBe('Priyanka,1,1800,2,1,900,Just right')
  })

  it('leaves an unanswered cell blank', () => {
    // Arjun answered the quiz and skipped the poll.
    expect(lines[2]).toBe('Arjun,2,900,1,0,0,')
  })

  it('starts with a BOM so Excel reads UTF-8', () => {
    expect(toGradebookCsv(results).charCodeAt(0)).toBe(0xfeff)
  })

  it('names a removed option rather than leaving the cell blank', () => {
    const r = shapeResults([pollSlide], people, [
      ans({ slideId: 's2', participantId: 'a', optionId: 'abcdef1234-gone' }),
    ])
    expect(toGradebookCsv(r).split('\r\n')[1]).toContain('(removed option abcdef12)')
  })
})

describe('csvFilename', () => {
  it('slugs the deck title and stamps the end date', () => {
    expect(csvFilename('Operating Systems: Week 4', new Date(2026, 8, 4))).toBe(
      'operating-systems-week-4-results-2026-09-04.csv',
    )
  })

  it('falls back when the deck is gone or unnameable', () => {
    expect(csvFilename(null, new Date(2026, 8, 4))).toBe('session-results-2026-09-04.csv')
    expect(csvFilename('!!!', new Date(2026, 8, 4))).toBe('session-results-2026-09-04.csv')
  })
})
