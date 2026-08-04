import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants, sessions } from '@/lib/db/schema'
import { rankLeaderboard } from '@/lib/realtime/aggregate'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { correctOptionId } from '@/lib/mcq'
import { explanationOf } from '@/lib/slides'
import { currentSlide, tallySlideAnswers } from '@/lib/realtime/live-slide'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { getHostedSession } from '@/lib/sessions'

// Host-only: disclose the correct answer and broadcast the re-ranked leaderboard. The
// re-rank happens HERE (not per answer) — that IS the animated reorder, and it's what
// keeps the hot path flat at 100.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const session = await getHostedSession(code, await hostTokenFrom(req, code))
  if (!session) return bad(404, 'session not found')

  const slide = await currentSlide(session)
  if (!slide) return bad(409, 'no slide is live')

  const aggregate = await tallySlideAnswers(session.id, slide.id)

  const parts = await db
    .select({
      participantId: participants.id,
      nickname: participants.nickname,
      avatarSeed: participants.avatarSeed,
      score: participants.score,
    })
    .from(participants)
    .where(eq(participants.sessionId, session.id))
  const top = rankLeaderboard(parts, session.lastTopn)

  // Close the answer window BEFORE broadcasting the correct option: flipping status off
  // 'active' makes answersOpen() false, so late submits are rejected the moment reveal
  // commits (see answer/route.ts). Also remember this top-N for the next delta computation,
  // and record that this slide's key is now public so re-showing it can't reopen scoring
  // (see advance/route.ts).
  //
  // Guarded on status like advance: `end` can commit between the read above and this write,
  // and an unconditional update would reopen the closed room as 'revealed'. Nothing is
  // disclosed unless this transition wins.
  const applied = await db
    .update(sessions)
    .set({
      status: 'revealed',
      lastTopn: top.map((e) => ({ participantId: e.participantId, rank: e.rank })),
      revealedSlideIds: session.revealedSlideIds.includes(slide.id)
        ? session.revealedSlideIds
        : [...session.revealedSlideIds, slide.id],
    })
    .where(and(eq(sessions.id, session.id), ne(sessions.status, 'ended')))
    .returning({ id: sessions.id })
  if (applied.length === 0) return bad(409, 'session has ended')

  // null on an unscored type — a poll has nothing to disclose, so reveal just closes voting
  // and publishes the final tally.
  const correct = correctOptionId(slide.config)
  // The explanation ships only here and in the re-show path — it names the answer, so it
  // must never ride slide:show for a live question.
  const reveal = {
    slideId: slide.id,
    correctOptionId: correct ?? undefined,
    aggregate,
    explanation: explanationOf(slide.config),
  }
  await broadcast(code, EVENTS.SLIDE_REVEAL, reveal)
  await broadcast(code, EVENTS.LEADERBOARD_UPDATE, { top })

  return Response.json({ ok: true, ...reveal, correctOptionId: correct, top })
}
