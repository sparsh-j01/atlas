import { describe, expect, it } from 'vitest'
import { buildPerformanceReport } from './performance-report'
import { shapeResults, type SlideRow, type AnswerRow } from './results'

const quiz: SlideRow = { id: 'q1', type: 'quiz_mcq', prompt: 'Why does deadlock occur?', position: 0,
  config: { timeLimitMs: 5000, points: 1000, options: [{ id: 'right', text: 'Four conditions', is_correct: true }, { id: 'wrong', text: 'One condition', is_correct: false }] } }
const people = [0, 1, 2, 3].map((i) => ({ participantId: `p${i}`, nickname: `Student ${i}`, avatarSeed: `p${i}`, score: i === 0 ? 900 : 0 }))
const answers: AnswerRow[] = [0, 1, 2].map((i) => ({
  participantId: `p${i}`, slideId: 'q1', optionId: i === 0 ? 'right' : 'wrong', isCorrect: i === 0,
  pointsAwarded: i === 0 ? 900 : 0, responseMs: 4200,
}))

describe('teacher improvement report', () => {
  it('distinguishes class correctness, accuracy among attempts, and completion', () => {
    const report = buildPerformanceReport(shapeResults([quiz], people, answers, ['q1']))
    expect(report.masteryPercent).toBe(25)
    expect(report.attemptedAccuracy).toBe(33)
    expect(report.completionPercent).toBe(75)
    expect(report.scoredQuestions).toBe(1)
    expect(report.needsSupport).toBe(3)
  })

  it('identifies a shared incorrect choice and ties the lecture suggestion to that evidence', () => {
    const report = buildPerformanceReport(shapeResults([quiz], people, answers, ['q1']))
    expect(report.priorities[0].commonWrong).toEqual({ text: 'One condition', count: 2 })
    expect(report.priorities[0].suggestion).toContain('One condition')
    expect(report.patterns.join(' ')).toContain('multiple students')
    expect(report.patterns.join(' ')).toContain('80%')
    expect(report.individuals.find((p) => p.participantId === 'p3')?.unansweredQuestions).toHaveLength(1)
    expect(report.individuals.find((p) => p.participantId === 'p1')?.wrongQuestions).toHaveLength(1)
  })

  it('reports unanswered questions without claiming they prove a misconception', () => {
    const report = buildPerformanceReport(shapeResults([quiz], people, [], ['q1']))
    expect(report.masteryPercent).toBe(0)
    expect(report.attemptedAccuracy).toBeNull()
    expect(report.priorities[0].commonWrong).toBeNull()
    expect(report.priorities[0].suggestion).toContain('could submit')
  })

  it('does not invent analysis for an empty session', () => {
    const report = buildPerformanceReport(shapeResults([], [], []))
    expect(report.masteryPercent).toBeNull()
    expect(report.needsSupport).toBe(0)
  })
})
