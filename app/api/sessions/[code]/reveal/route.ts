import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions } from '@/lib/db/schema'
import { rankLeaderboard, tallyMcq } from '@/lib/realtime/aggregate'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { correctOptionId } from '@/lib/mcq'
import { currentSlide } from '@/lib/realtime/live-slide'
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

  const answerRows = await db
    .select({ response: answers.response })
    .from(answers)
    .where(and(eq(answers.sessionId, session.id), eq(answers.slideId, slide.id)))
  const aggregate = tallyMcq(answerRows.map((r) => ({ optionId: r.response.optionId })))

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
  // commits (see answer/route.ts). Also remember this top-N for the next delta computation.
  await db
    .update(sessions)
    .set({
      status: 'revealed',
      lastTopn: top.map((e) => ({ participantId: e.participantId, rank: e.rank })),
    })
    .where(eq(sessions.id, session.id))

  const correct = correctOptionId(slide.config)
  await broadcast(code, EVENTS.SLIDE_REVEAL, {
    slideId: slide.id,
    correctOptionId: correct ?? undefined,
    aggregate,
  })
  await broadcast(code, EVENTS.LEADERBOARD_UPDATE, { top })

  return Response.json({ ok: true, slideId: slide.id, correctOptionId: correct, aggregate, top })
}
