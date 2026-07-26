import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants, sessions } from '@/lib/db/schema'
import { rankLeaderboard } from '@/lib/realtime/aggregate'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { getHostedSession } from '@/lib/sessions'

// Host-only: close the room. Ending frees the 6-digit code for reuse (the unique index is
// partial on status <> 'ended') and unlocks the deck for editing again (lib/decks.ts).
// The podium UI is M4; what lands here is the final ranking every client needs to render it.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const session = await getHostedSession(code, await hostTokenFrom(req, code))
  if (!session) return bad(404, 'session not found')

  const parts = await db
    .select({
      participantId: participants.id,
      nickname: participants.nickname,
      avatarSeed: participants.avatarSeed,
      score: participants.score,
    })
    .from(participants)
    .where(eq(participants.sessionId, session.id))
  const fullRanking = rankLeaderboard(parts, session.lastTopn, parts.length)

  // Flip status before broadcasting: 'ended' closes the answer window (answersOpen) the
  // moment this commits, so nothing sneaks in between the update and the fan-out.
  await db
    .update(sessions)
    .set({ status: 'ended', endedAt: new Date() })
    .where(eq(sessions.id, session.id))

  await broadcast(code, EVENTS.SESSION_ENDED, { podium: fullRanking.slice(0, 3), fullRanking })

  return Response.json({ ok: true, fullRanking })
}
