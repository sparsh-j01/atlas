import { explanationOf } from './slides'
import type { AnswerRow, SlideRow } from './results'

export type ReviewQuestion = {
  slideId: string
  number: number
  prompt: string
  outcome: 'correct' | 'wrong' | 'unanswered'
  options: { id: string; text: string; correct: boolean; picked: boolean }[]
  explanation: string | null
}

export type ParticipantReview = {
  nickname: string
  score: number
  rank: number
  correct: number
  wrong: number
  unanswered: number
  scoredQuestions: number
  questions: ReviewQuestion[]
}

/** Only the caller's answers belong in this input and output. */
export function buildParticipantReview(slides: SlideRow[], answers: AnswerRow[], shownIds: string[], participant: {
  participantId: string; nickname: string; score: number; rank: number
}): ParticipantReview {
  const own = new Map(answers.filter((a) => a.participantId === participant.participantId).map((a) => [a.slideId, a]))
  const shown = new Set([...shownIds, ...own.keys()])
  const questions: ReviewQuestion[] = [...slides].sort((a, b) => a.position - b.position)
    .filter((s) => shown.has(s.id)).map((s, i) => {
      const answer = own.get(s.id)
      return {
        slideId: s.id, number: i + 1, prompt: s.prompt,
        outcome: !answer ? 'unanswered' : answer.isCorrect ? 'correct' : 'wrong',
        options: s.config.options.map((o) => ({
          id: o.id, text: o.text, correct: o.is_correct === true, picked: answer?.optionId === o.id,
        })),
        explanation: explanationOf(s.config) ?? null,
      }
    })
  return {
    nickname: participant.nickname, score: participant.score, rank: participant.rank,
    scoredQuestions: questions.length,
    correct: questions.filter((q) => q.outcome === 'correct').length,
    wrong: questions.filter((q) => q.outcome === 'wrong').length,
    unanswered: questions.filter((q) => q.outcome === 'unanswered').length,
    questions,
  }
}
