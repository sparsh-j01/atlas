import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { buildParticipantReview } from './participant-review'
import { StudentReview } from '@/components/StudentReview'
import type { AnswerRow, SlideRow } from './results'

const slides: SlideRow[] = [0, 1, 2].map((position) => ({
  id: `q${position}`, position, type: 'quiz_mcq', prompt: `Question ${position}`,
  config: { timeLimitMs: 5000, points: 1000, explanation: `Explanation ${position}`,
    options: [{ id: `right${position}`, text: 'Right', is_correct: true }, { id: `wrong${position}`, text: 'Wrong', is_correct: false }] },
}))
const person = { participantId: 'me', nickname: 'Asha', rank: 2, score: 900 }
const answers: AnswerRow[] = [
  { slideId: 'q0', participantId: 'me', optionId: 'right0', isCorrect: true, pointsAwarded: 900, responseMs: 2000 },
  { slideId: 'q1', participantId: 'me', optionId: 'wrong1', isCorrect: false, pointsAwarded: 0, responseMs: 3000 },
  { slideId: 'q2', participantId: 'somebody-else', optionId: 'right2', isCorrect: true, pointsAwarded: 900, responseMs: 2000 },
]

describe('personal answer review', () => {
  it('shows every completed question, including a timeout, using only this student’s answers', () => {
    const review = buildParticipantReview(slides, answers, ['q0', 'q1', 'q2'], person)
    expect(review.questions.map((q) => q.outcome)).toEqual(['correct', 'wrong', 'unanswered'])
    expect(review.correct).toBe(1)
    expect(review.wrong).toBe(1)
    expect(review.unanswered).toBe(1)
    expect(review.questions[2].options.every((o) => !o.picked)).toBe(true)
  })

  it('does not include slides that were never reached', () => {
    const review = buildParticipantReview(slides, [], ['q0'], person)
    expect(review.questions.map((q) => q.slideId)).toEqual(['q0'])
    expect(review.scoredQuestions).toBe(1)
    expect(review.questions[0].outcome).toBe('unanswered')
  })

  it('opens explanations for mistakes and keeps correct-answer explanations expandable', () => {
    const review = buildParticipantReview(slides, answers, ['q0', 'q1'], person)
    const html = renderToStaticMarkup(createElement(StudentReview, { review, onJoinAgain: () => {} }))
    const details = html.match(/<details[^>]*>[\s\S]*?<\/details>/g) ?? []
    expect(details).toHaveLength(1)
    expect(details[0]).toContain('Explanation 0')
    expect(details[0]).not.toMatch(/<details[^>]*\bopen/)
    expect(details[0]).not.toContain('Explanation 1')
    expect(html).toContain('Explanation 1')
    expect(html).toContain('Your answer · correct')
  })
})
