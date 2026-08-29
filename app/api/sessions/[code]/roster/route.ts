import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants } from '@/lib/db/schema'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { getHostedSession } from '@/lib/sessions'

// Host-only: the lobby roster as the SERVER knows it.
//
// This exists because Presence is not a source of truth about who is in the room. A
// presence payload is written by the client, and migration 0005's INSERT policy can only
// see the topic and `extension = 'presence'` — it cannot tell a real participant from
// anyone else holding the anon key (which ships in the browser bundle) and the 6-digit
// code (which is projected on the wall to the whole class). So anyone in the room could
// `track({ nickname })` with any string, land it on the projector without ever passing
// sanitizeNickname, and survive /kick — which deletes a participants row that a forged
// entry never had.
//
// The split that fixes it: Presence answers WHO IS CONNECTED (participant ids, untrusted
// but harmless — an id nobody issued matches no row here). This route answers WHAT THEIR
// NAME IS, from the row the join endpoint wrote after sanitizing it. The host console
// renders the intersection, so an unissued id renders nothing at all.
//
// Host-token authorized like every other control route: a wrong or missing token 404s
// exactly like a wrong code, so this never confirms a session exists to a non-host.
export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const session = await getHostedSession(code, await hostTokenFrom(req, code))
  if (!session) return bad(404, 'session not found')

  // Capped by MAX_PARTICIPANTS_PER_SESSION on the join route, so this is bounded at 300
  // rows of three short columns — no pagination needed at this scale.
  const roster = await db
    .select({
      participantId: participants.id,
      nickname: participants.nickname,
      avatarSeed: participants.avatarSeed,
    })
    .from(participants)
    .where(eq(participants.sessionId, session.id))
    .orderBy(asc(participants.joinedAt))

  return Response.json({ roster })
}
