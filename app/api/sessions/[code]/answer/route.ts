import { and, eq, exists, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions } from '@/lib/db/schema'
import { correctOptionId, isValidOptionId } from '@/lib/mcq'
import { currentSlideLateral } from '@/lib/realtime/live-slide'
import { scoreAnswer } from '@/lib/realtime/scoring'
import { answersOpen, withinAnswerWindow } from '@/lib/realtime/session-state'
import { bad } from '@/lib/realtime/session-util'
import { isRoomCode, isUuid } from '@/lib/ids'

// Server-authoritative answer: rejects late answers by SERVER receipt time, scores, and
// persists + bumps the participant atomically (idempotent on re-submit). Nothing is
// broadcast per answer: standings go out once per question, from session-progress.
//
// Every query here waits for a free connection from the DB pool before it runs, and under a
// classroom burst that wait, not Postgres, is where the time goes (2026-10-04 trace: ~0.5 s
// per query at 120 answers, up to 17 s before the late check at 500). So the path is written
// to need as few of them as it can: one read, two locks, one write.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  // Server RECEIPT time, stamped before anything that can wait. Stamped after the reads, as it
  // used to be, a student's time queued on OUR server counted against their answer window and
  // their speed score, and at 120 answers that cost up to 2.7 s each. docs/schema.md defines
  // response_ms as receipt time − slide start; this is that.
  const receivedAt = Date.now()
  const { code } = await params
  const body = await req.json().catch(() => null)
  const clientToken = typeof body?.clientToken === 'string' ? body.clientToken : ''
  if (!clientToken) return bad(400, 'clientToken is required')
  // This read doesn't go through findLiveSession, so it checks the formats itself: a NUL byte
  // in either value is a Postgres error, not "no row". Same 403 as the join below returns for
  // a token that matches nobody, so a malformed one tells the caller nothing more.
  if (!isRoomCode(code) || !isUuid(clientToken)) return bad(403, 'unknown participant')

  // Room, caller and live slide in ONE round trip; they used to be three.
  const live = currentSlideLateral()
  const [row] = await db
    .select({
      session: { id: sessions.id, status: sessions.status, currentSlideStartedAt: sessions.currentSlideStartedAt },
      participantId: participants.id,
      slide: { id: live.id, type: live.type, prompt: live.prompt, config: live.config },
    })
    .from(sessions)
    .innerJoin(participants, and(eq(participants.sessionId, sessions.id), eq(participants.clientToken, clientToken)))
    .leftJoinLateral(live, eq(live.index, sessions.currentSlideIndex))
    .where(and(eq(sessions.code, code), ne(sessions.status, 'ended')))
    .limit(1)
  // Who is asking comes before anything about the room, with ONE answer for "no such room"
  // and "not in this room" — the inner join returns no row for either. Checked after the
  // slide, as this used to be, a junk token got 400 from a live room with an open question
  // and 409 from a dead code — a way to find live rooms by guessing codes. Only a real
  // participant gets to see the 409 / 400 below.
  if (!row) return bad(403, 'unknown participant')
  const { session, slide } = row
  const p = { id: row.participantId }

  // Only a live question takes answers: in the lobby or once the session has ended,
  // answersOpen() is false and we reject here.
  if (!answersOpen(session)) {
    return bad(409, 'session is not accepting answers')
  }

  // The live slide is the only valid target: option ids are per-slide uuids, so an answer
  // aimed at the previous slide fails this check rather than scoring against the new one.
  if (!slide || !isValidOptionId(slide.config, body?.optionId))
    return bad(400, 'a valid optionId is required')
  const optionId = body.optionId

  // No per-participant rate limit here on purpose. This route is already bounded twice by
  // things that are true across every serverless instance: the answer window is closed by
  // the SERVER clock, and a re-submit is idempotent on (participant, slide). A counter in
  // process memory would add nothing those two don't already cover, while a false 429
  // mid-question — a lambda that happens to hold a stale count — silently costs a student
  // their answer. Correctness beats a guard that can only misfire.
  const { timeLimitMs } = slide.config
  // Floored at 0: receipt is now stamped before the reads, so a host re-showing this slide
  // (which restarts its clock) can land between an answer's receipt and its read.
  const responseMs = Math.max(0, receivedAt - session.currentSlideStartedAt.getTime())
  // Late answers are rejected by the server clock — never a client-sent timestamp — but with
  // a grace window, because receipt time includes the upload the tap had to make. See
  // ANSWER_GRACE_MS: an answer inside the grace scores the floor, so it buys nothing.
  if (!withinAnswerWindow(responseMs, timeLimitMs)) {
    return Response.json({ accepted: false, reason: 'late' })
  }

  // Whether they were right doesn't depend on any mutable participant state, so it's settled
  // out here. What it's WORTH does depend on the streak, and that is read under a lock below.
  const correct = optionId === correctOptionId(slide.config)

  // Insert the answer and bump the participant in one transaction. A unique conflict
  // (session, slide, participant) means they already answered → idempotent, no re-score.
  const applied = await db.transaction(async (tx) => {
    // Shared locks allow the class to answer concurrently. The deadline transition takes
    // an exclusive lock and waits for accepted scores, so the standings include them all.
    const [liveSession] = await tx.select({ status: sessions.status, currentSlideStartedAt: sessions.currentSlideStartedAt })
      .from(sessions).where(eq(sessions.id, session.id)).for('share')
    if (!liveSession || !answersOpen(liveSession) ||
      liveSession.currentSlideStartedAt.getTime() !== session.currentSlideStartedAt.getTime()) return false
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

    const { points, newStreak } = scoreAnswer({ correct, responseMs, timeLimitMs, priorStreak: locked.streak })

    // Insert the answer and bump the participant in ONE statement, one round trip less while
    // the lock is held. The UPDATE runs only if the INSERT did (`exists (select from ins)`), so
    // a re-submit — unique conflict, nothing inserted — changes nothing and returns no row,
    // exactly as the separate insert-then-update did.
    const ins = tx.$with('ins').as(
      tx
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
        .returning({ id: answers.id }),
    )
    // Increment in SQL rather than writing back a score computed in JS: let the database do
    // the addition and the total is correct because of how it's written, not because of what
    // else happens to be true. `streak` can't be an increment (it resets on a wrong answer),
    // so it's a plain write — safe only because of the lock above, which is what makes it
    // last-writer-wins over a value nobody else can still be holding.
    const bumped = await tx
      .with(ins)
      .update(participants)
      .set({
        score: sql`${participants.score} + ${points}`,
        streak: newStreak,
        lastSeenAt: new Date(),
      })
      .where(and(eq(participants.id, p.id), exists(tx.select().from(ins))))
      .returning({ id: participants.id })
    return bumped.length > 0
  })
  if (!applied) {
    const [existing] = await db.select({ id: answers.id }).from(answers)
      .where(and(eq(answers.sessionId, session.id), eq(answers.slideId, slide.id), eq(answers.participantId, p.id))).limit(1)
    return existing
      ? Response.json({ accepted: true, alreadyAnswered: true })
      : Response.json({ accepted: false, reason: 'closed' })
  }

  // Own-correctness is withheld until the end-of-quiz review; nothing leaks mid-game.
  return Response.json({ accepted: true })
}
