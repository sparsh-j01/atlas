import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants } from '@/lib/db/schema'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { getHostedSession } from '@/lib/sessions'

// Host-only: remove a participant from the live room.
//
// This is the other half of the nickname filter (lib/nickname.ts). Any wordlist is beatable
// by someone who wants to beat it, and the thing that makes a miss survivable is not a
// better list — it's the host being able to take the name off the projector in one click,
// mid-game, without ending the session.
//
// ponytail: removal is not a ban. Nothing stops the same phone rejoining under a new
// nickname, because there is no identity to ban — joining is anonymous by design. The
// upgrade path is the join rate limiting already scheduled for M8, which is where
// per-IP state has to be solved anyway. A kick still wins the moment it is used for: the
// name is off the screen, and the score that carried it is gone from the leaderboard.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  // Wrong/missing token 404s exactly like a wrong code — same rule as advance/reveal/end:
  // never confirm a session exists to someone who can't host it.
  const session = await getHostedSession(code, await hostTokenFrom(req, code))
  if (!session) return bad(404, 'session not found')

  const body = await req.json().catch(() => null)
  const participantId = typeof body?.participantId === 'string' ? body.participantId : ''
  if (!participantId) return bad(400, 'participantId is required')

  // Scoped to THIS session, so a host can't delete a participant out of someone else's room
  // by holding a valid token for their own. Delete rather than flag: their answers cascade
  // (answers.participant_id ON DELETE CASCADE), which is what takes their score off the
  // leaderboard as well as their name off the roster.
  const [removed] = await db
    .delete(participants)
    .where(and(eq(participants.sessionId, session.id), eq(participants.id, participantId)))
    .returning({ id: participants.id })
  if (!removed) return bad(404, 'participant not found')

  // Their phone leaves the room on this. Best-effort like every broadcast: if it never
  // arrives, their next answer fails as an unknown participant and /state 404s them out,
  // so the removal holds either way.
  await broadcast(code, EVENTS.PARTICIPANT_KICKED, { participantId: removed.id })

  return Response.json({ removed: removed.id })
}
