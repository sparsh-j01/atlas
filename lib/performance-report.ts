import type { QuestionResult, SessionResults } from './results'

export type QuestionInsight = {
  question: QuestionResult
  successPercent: number
  unanswered: number
  commonWrong: { text: string; count: number } | null
  suggestion: string
}

export function buildPerformanceReport(results: SessionResults) {
  const students = results.participants.length
  const scored = results.questions.filter((q) => q.scored)
  const opportunities = students * scored.length
  const correct = scored.reduce((n, q) => n + q.correct, 0)
  const attempted = scored.reduce((n, q) => n + q.answered, 0)
  const percent = (n: number, total: number) => total ? Math.round(n / total * 100) : null
  const questions: QuestionInsight[] = scored.map((question) => {
    const wrong = [...question.options].filter((o) => !o.isCorrect && o.count > 0).sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))[0]
    const unanswered = Math.max(0, students - question.answered)
    const successPercent = percent(question.correct, students) ?? 0
    const commonWrong = wrong ? { text: wrong.text, count: wrong.count } : null
    const suggestion = successPercent >= 80
      ? 'Use a short retrieval check next lecture, then build on this material.'
      : commonWrong
        ? `Contrast “${commonWrong.text}” with the correct answer in a worked example, then check understanding with a new question.`
        : unanswered > 0
          ? 'Check whether students had enough time and could submit. Revisit this question with a worked example before testing it again.'
          : 'Revisit the reasoning with a worked example and a short follow-up question.'
    return { question, successPercent, unanswered, commonWrong, suggestion }
  }).sort((a, b) => a.successPercent - b.successPercent || a.question.number - b.question.number)

  const individuals = results.participants.map((p) => {
    const correctQuestions = scored.filter((q) => p.bySlide[q.slideId]?.isCorrect === true)
    const wrongQuestions = scored.filter((q) => p.bySlide[q.slideId]?.isCorrect === false)
    const unansweredQuestions = scored.filter((q) => !p.bySlide[q.slideId])
    const masteryPercent = percent(correctQuestions.length, scored.length)
    return { ...p, masteryPercent, wrongQuestions, unansweredQuestions,
      correctCount: correctQuestions.length,
      recommendation: masteryPercent === null ? 'No scored questions were completed.'
        : masteryPercent >= 80 ? 'Ready for extension practice; use a brief check to confirm retention next lecture.'
        : wrongQuestions.length > 0 ? `Review questions ${wrongQuestions.map((q) => q.number).join(', ')} with feedback, then try a similar question independently.`
        : 'Check access and time limits, then offer another attempt to assess understanding.',
    }
  })

  const patterns: string[] = []
  const shared = questions.filter((q) => q.commonWrong && q.commonWrong.count >= 2)
  if (shared.length) patterns.push(`${shared.length} ${shared.length === 1 ? 'question had' : 'questions had'} the same incorrect option chosen by multiple students. Use the contrasts below to guide the next lecture.`)
  const unanswered = opportunities - attempted
  if (unanswered > 0) patterns.push(`${unanswered} of ${opportunities} possible answers were left blank. Check time limits, attendance, and connection problems alongside understanding.`)
  const slow = scored.filter((q) => q.avgResponseMs !== null && q.timeLimitMs !== null && q.avgResponseMs >= q.timeLimitMs * 0.8)
  if (slow.length) patterns.push(`On questions ${slow.map((q) => q.number).join(', ')}, submitted answers used at least 80% of the available time on average. Allow more thinking time when revisiting this material.`)
  if (scored.length >= 4 && students > 0) {
    const half = Math.floor(scored.length / 2)
    const rate = (qs: QuestionResult[]) => percent(qs.reduce((n, q) => n + q.correct, 0), students * qs.length) ?? 0
    const first = rate(scored.slice(0, half)), last = rate(scored.slice(half))
    if (first - last >= 20) patterns.push(`Correct-answer rates fell from ${first}% in the first part to ${last}% in the later part. Compare question difficulty and pacing before deciding what to reteach.`)
  }
  if (!patterns.length && opportunities > 0) patterns.push('No repeated wrong-answer or timing pattern stands out in this quiz. Use the question-level results to choose the next practice activity.')

  return {
    students, scoredQuestions: scored.length,
    masteryPercent: percent(correct, opportunities),
    attemptedAccuracy: percent(correct, attempted),
    completionPercent: percent(attempted, opportunities),
    needsSupport: individuals.filter((p) => p.masteryPercent !== null && p.masteryPercent < 60).length,
    priorities: questions.filter((q) => q.successPercent < 80),
    strengths: questions.filter((q) => q.successPercent >= 80),
    patterns, individuals,
  }
}
