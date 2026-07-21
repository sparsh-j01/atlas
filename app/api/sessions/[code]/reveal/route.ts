import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions } from '@/lib/db/schema'
import { rankLeaderboard, tallyMcq } from '@/lib/realtime/aggregate'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { correctOptionId, SPIKE_SLIDE_ID } from '@/lib/realtime/question'
import { bad, findLiveSession } from '@/lib/realtime/session-util'

// Host-only: disclose the correct answer and broadcast the re-ranked leaderboard. The
// re-rank happens HERE (not per answer) — that IS the animated reorder, and it's what
// keeps the hot path flat at 100. Caller must present the session's host_token.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const body = await req.json().catch(() => null)
  const hostToken = typeof body?.hostToken === 'string' ? body.hostToken : ''

  const session = await findLiveSession(code)
  if (!session) return bad(404, 'session not found')
  if (!hostToken || hostToken !== session.hostToken) return bad(403, 'host only')

  const answerRows = await db
    .select({ response: answers.response })
    .from(answers)
    .where(and(eq(answers.sessionId, session.id), eq(answers.slideId, SPIKE_SLIDE_ID)))
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

  // Remember this top-N so the next leaderboard broadcast can compute movement deltas.
  await db
    .update(sessions)
    .set({ lastTopn: top.map((e) => ({ participantId: e.participantId, rank: e.rank })) })
    .where(eq(sessions.id, session.id))

  await broadcast(code, EVENTS.SLIDE_REVEAL, {
    slideId: SPIKE_SLIDE_ID,
    correctOptionId: correctOptionId(),
    aggregate,
  })
  await broadcast(code, EVENTS.LEADERBOARD_UPDATE, { top })

  return Response.json({ ok: true })
}
