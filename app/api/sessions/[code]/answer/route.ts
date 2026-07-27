import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions } from '@/lib/db/schema'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { correctOptionId, isValidOptionId } from '@/lib/mcq'
import { isScored } from '@/lib/slides'
import { currentSlide, tallySlideAnswers } from '@/lib/realtime/live-slide'
import { scoreAnswer } from '@/lib/realtime/scoring'
import { answersOpen, withinAnswerWindow } from '@/lib/realtime/session-state'
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
  // Late answers are rejected by the server clock — never a client-sent timestamp — but with
  // a grace window, because receipt time includes the upload the tap had to make. See
  // ANSWER_GRACE_MS: an answer inside the grace scores the floor, so it buys nothing.
  if (!withinAnswerWindow(responseMs, timeLimitMs)) {
    return Response.json({ accepted: false, reason: 'late' })
  }

  // Unscored types (poll) record the response and award nothing. `isCorrect` stays null —
  // there is no correct answer to record — and the streak is carried through untouched
  // rather than recomputed: a poll dropped between two quiz questions must not break a
  // player's run. Branching on `correct === null` rather than on `scored` separately keeps
  // the two from drifting: there is exactly one way to reach scoreAnswer.
  const correct = isScored(slide.type) ? optionId === correctOptionId(slide.config) : null
  const { points, newStreak } =
    correct === null
      ? { points: 0, newStreak: p.streak }
      : scoreAnswer({ correct, responseMs, timeLimitMs, priorStreak: p.streak })

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
    // Increment in SQL rather than writing back `p.score + points` computed in JS. The
    // unique index above already stops the same player scoring one slide twice, so today
    // the read-modify-write is safe — but only as a side effect of that index, and only
    // while one answer per player can be in flight. Let the database do the addition and
    // the score is correct because of how it's written, not because of what else happens
    // to be true. `streak` can't be an increment (it resets on a wrong answer), so it
    // stays last-writer-wins.
    await tx
      .update(participants)
      .set({
        score: sql`${participants.score} + ${points}`,
        streak: newStreak,
        lastSeenAt: new Date(),
      })
      .where(eq(participants.id, p.id))
    return true
  })
  if (!applied) return Response.json({ accepted: true, alreadyAnswered: true })

  // Leaky-bucket throttle on the session row: only the writer that wins the window
  // recomputes the count and broadcasts; everyone else just persisted their answer.
  //
  // One second, not 200ms, and the reason is a hard vendor limit rather than taste.
  // Supabase bills AND rate-limits Realtime per delivered copy: one broadcast to a room of
  // 100 phones plus the projector is ~102 messages, not 1. The documented ceiling is 100
  // messages/second on Free and 500 on Pro, and crossing it does not cost money, it
  // DISCONNECTS the clients until throughput drops. At 200ms this room would run ~510/s:
  // over Pro, 5x over Free, at exactly the 100-player concurrency this project exists to
  // demonstrate. At 1s it is ~102/s with room to spare on both.
  // ponytail: a wall-clock window is the cheap fix. If the counter ever needs to feel
  // smoother, interpolate on the client between messages rather than sending more of them.
  const won = await db
    .update(sessions)
    .set({ lastBcast: sql`now()` })
    .where(
      and(
        eq(sessions.id, session.id),
        or(isNull(sessions.lastBcast), lt(sessions.lastBcast, sql`now() - interval '1 second'`)),
      ),
    )
    .returning({ id: sessions.id })
  if (won.length > 0) {
    if (correct === null) {
      // Unscored: send the live distribution. This is the `results:update` path M4 left
      // deliberately unused — on a scored question a running tally lets the room herd
      // toward whatever is winning, but a poll has no answer to protect, and watching the
      // bars move IS the slide.
      const aggregate = await tallySlideAnswers(session.id, slide.id)
      await broadcast(code, EVENTS.RESULTS_UPDATE, { slideId: slide.id, aggregate })
    } else {
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
  }

  // Own-correctness is withheld until reveal (Kahoot-style suspense; nothing leaks).
  return Response.json({ accepted: true })
}
