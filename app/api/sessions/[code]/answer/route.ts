import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions } from '@/lib/db/schema'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { correctOptionId, isValidOptionId } from '@/lib/mcq'
import { currentSlide } from '@/lib/realtime/live-slide'
import { scoreAnswer } from '@/lib/realtime/scoring'
import { answersOpen } from '@/lib/realtime/session-state'
import { bad, findLiveSession } from '@/lib/realtime/session-util'

// Server-authoritative answer: rejects late answers by SERVER receipt time, scores,
// persists + bumps the participant atomically (idempotent on re-submit), then broadcasts
// a live answered-count throttled by a DB leaky-bucket so 100 answers ≠ 100 messages.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const body = await req.json().catch(() => null)
  const clientToken = typeof body?.clientToken === 'string' ? body.clientToken : ''
  if (!clientToken) return bad(400, 'clientToken is required')

  const session = await findLiveSession(code)
  // Reveal-gate: once the host reveals (status → 'revealed'), answersOpen() is false and we
  // reject here, even if the participant's own timer hasn't elapsed. Closes the cheat window.
  if (!session || !answersOpen(session)) {
    return bad(409, 'session is not accepting answers')
  }

  // The live slide is the only valid target: option ids are per-slide uuids, so an answer
  // aimed at the previous slide fails this check rather than scoring against the new one.
  const slide = await currentSlide(session)
  if (!slide || !isValidOptionId(slide.config, body?.optionId))
    return bad(400, 'a valid optionId is required')
  const optionId = body.optionId

  const [p] = await db
    .select()
    .from(participants)
    .where(and(eq(participants.sessionId, session.id), eq(participants.clientToken, clientToken)))
    .limit(1)
  if (!p) return bad(403, 'unknown participant')

  const { timeLimitMs } = slide.config
  const responseMs = Date.now() - session.currentSlideStartedAt.getTime()
  // Late answers are rejected by the server clock — never a client-sent timestamp.
  if (responseMs > timeLimitMs) {
    return Response.json({ accepted: false, reason: 'late' })
  }

  const correct = optionId === correctOptionId(slide.config)
  const { points, newStreak } = scoreAnswer({
    correct,
    responseMs,
    timeLimitMs,
    priorStreak: p.streak,
  })

  // Insert the answer and bump the participant in one transaction. A unique conflict
  // (session, slide, participant) means they already answered → idempotent, no re-score.
  const applied = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(answers)
      .values({
        sessionId: session.id,
        slideId: slide.id,
        participantId: p.id,
        response: { optionId },
        isCorrect: correct,
        pointsAwarded: points,
        responseMs,
      })
      .onConflictDoNothing()
      .returning({ id: answers.id })
    if (inserted.length === 0) return false
    await tx
      .update(participants)
      .set({ score: p.score + points, streak: newStreak, lastSeenAt: new Date() })
      .where(eq(participants.id, p.id))
    return true
  })
  if (!applied) return Response.json({ accepted: true, alreadyAnswered: true })

  // Leaky-bucket throttle on the session row: only the writer that wins the 200ms window
  // recomputes the count and broadcasts; everyone else just persisted their answer.
  const won = await db
    .update(sessions)
    .set({ lastBcast: sql`now()` })
    .where(
      and(
        eq(sessions.id, session.id),
        or(isNull(sessions.lastBcast), lt(sessions.lastBcast, sql`now() - interval '200 milliseconds'`)),
      ),
    )
    .returning({ id: sessions.id })
  if (won.length > 0) {
    const [{ answered }] = await db
      .select({ answered: count() })
      .from(answers)
      .where(and(eq(answers.sessionId, session.id), eq(answers.slideId, slide.id)))
    const [{ total }] = await db
      .select({ total: count() })
      .from(participants)
      .where(eq(participants.sessionId, session.id))
    await broadcast(code, EVENTS.ANSWERED_COUNT, { slideId: slide.id, answered, total })
  }

  // Own-correctness is withheld until reveal (Kahoot-style suspense; nothing leaks).
  return Response.json({ accepted: true })
}
