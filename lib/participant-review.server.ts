import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions, slides } from '@/lib/db/schema'
import { rankLeaderboard } from '@/lib/realtime/aggregate'
import { buildParticipantReview } from './participant-review'

export async function getParticipantReview(session: typeof sessions.$inferSelect, participantId: string) {
  if (session.status !== 'ended') return null
  const [deckSlides, ownAnswers, people] = await Promise.all([
    session.slideSnapshot ? Promise.resolve(session.slideSnapshot) : session.deckId
      ? db.select({ id: slides.id, type: slides.type, prompt: slides.prompt, config: slides.config, position: slides.position })
        .from(slides).where(eq(slides.deckId, session.deckId)).orderBy(asc(slides.position))
      : Promise.resolve([]),
    db.select({ slideId: answers.slideId, participantId: answers.participantId, optionId: answers.response,
      isCorrect: answers.isCorrect, pointsAwarded: answers.pointsAwarded, responseMs: answers.responseMs })
      .from(answers).where(and(eq(answers.sessionId, session.id), eq(answers.participantId, participantId))),
    db.select({ participantId: participants.id, nickname: participants.nickname, avatarSeed: participants.avatarSeed, score: participants.score })
      .from(participants).where(eq(participants.sessionId, session.id)),
  ])
  const ranking = rankLeaderboard(people, people.length)
  const me = ranking.find((p) => p.participantId === participantId)
  if (!me) return null
  return buildParticipantReview(deckSlides, ownAnswers.map((a) => ({ ...a, optionId: a.optionId.optionId })), session.revealedSlideIds, me)
}
