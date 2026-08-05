import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions } from '@/lib/db/schema'
import { broadcastToHost } from '@/lib/realtime/broadcast'
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

  // Whether they were right doesn't depend on any mutable participant state, so it's settled
  // out here. What it's WORTH does depend on the streak, and that is read under a lock below.
  const correct = isScored(slide.type) ? optionId === correctOptionId(slide.config) : null

  // Insert the answer and bump the participant in one transaction. A unique conflict
  // (session, slide, participant) means they already answered → idempotent, no re-score.
  const applied = await db.transaction(async (tx) => {
    // Lock the participant row before reading the streak the score derives from. The unique
    // index stops one player scoring one SLIDE twice, but it does not stop two answers for
    // DIFFERENT slides being in flight at once: a tap on the previous question can still be
    // travelling when the host advances and the player answers the next one. Both would
    // otherwise score off the same pre-transaction streak and the later write would clobber
    // the earlier one's bonus. Locking serialises the pair, so each reads the other's result.
    const [locked] = await tx
      .select({ streak: participants.streak })
      .from(participants)
      .where(eq(participants.id, p.id))
      .for('update')
    if (!locked) return false

    // Unscored types (poll) record the response and award nothing. `isCorrect` stays null —
    // there is no correct answer to record — and the streak is carried through untouched
    // rather than recomputed: a poll dropped between two quiz questions must not break a
    // player's run. Branching on `correct === null` rather than on `scored` separately keeps
    // the two from drifting: there is exactly one way to reach scoreAnswer.
    const { points, newStreak } =
      correct === null
        ? { points: 0, newStreak: locked.streak }
        : scoreAnswer({ correct, responseMs, timeLimitMs, priorStreak: locked.streak })

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
    // Increment in SQL rather than writing back a score computed in JS: let the database do
    // the addition and the total is correct because of how it's written, not because of what
    // else happens to be true. `streak` can't be an increment (it resets on a wrong answer),
    // so it's a plain write — safe only because of the lock above, which is what makes it
    // last-writer-wins over a value nobody else can still be holding.
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
  // Both of these go to the HOST channel, not the room. No participant renders either one
  // (app/play/page.tsx has no handler for them) — they drive the projector's counter and its
  // live chart. On the room channel each would cost ~1 message per phone, every second, for
  // data 100 phones decode and throw away; that was the single largest line in this app's
  // Realtime bill. See lib/realtime/channels.ts → hostChannel.
  if (won.length > 0) {
    if (correct === null) {
      // Unscored: send the live distribution. This is the `results:update` path M4 left
      // deliberately unused — on a scored question a running tally lets the room herd
      // toward whatever is winning, but a poll has no answer to protect, and watching the
      // bars move IS the slide.
      const aggregate = await tallySlideAnswers(session.id, slide.id)
      await broadcastToHost(code, EVENTS.RESULTS_UPDATE, { slideId: slide.id, aggregate })
    } else {
      const [{ answered }] = await db
        .select({ answered: count() })
        .from(answers)
        .where(and(eq(answers.sessionId, session.id), eq(answers.slideId, slide.id)))
      const [{ total }] = await db
        .select({ total: count() })
        .from(participants)
        .where(eq(participants.sessionId, session.id))
      await broadcastToHost(code, EVENTS.ANSWERED_COUNT, { slideId: slide.id, answered, total })
    }
  }

  // Own-correctness is withheld until reveal (Kahoot-style suspense; nothing leaks).
  return Response.json({ accepted: true })
}
