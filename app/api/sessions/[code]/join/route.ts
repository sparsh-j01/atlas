import { db } from '@/lib/db'
import { participants } from '@/lib/db/schema'
import { sanitizeNickname } from '@/lib/nickname'
import { currentSlide, sanitizeSlide } from '@/lib/realtime/live-slide'
import { bad, findLiveSession, newToken } from '@/lib/realtime/session-util'
import { answersOpen } from '@/lib/realtime/session-state'

// Anonymous participant join. Issues the SERVER-side client_token (identity); a
// client-set token is never trusted. Returns the live slide (if one is open) so the player
// can render immediately without racing the slide:show broadcast — a join during the lobby
// or a reveal gets null and waits for the next broadcast.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const body = await req.json().catch(() => null)
  // Trim, length, invisible characters and the blocklist, in one call — this nickname goes
  // on a projector in front of a room, and there is no account behind it to appeal to.
  // Server-side because it is the only side that counts; the filter is deliberately beatable,
  // which is why the host also gets /kick.
  const checked = sanitizeNickname(body?.nickname)
  if (!checked.ok) return bad(400, checked.error)
  const { nickname } = checked

  const session = await findLiveSession(code)
  if (!session) return bad(404, 'session not found')

  const clientToken = newToken()
  const avatarSeed = nickname // DiceBear seed; deterministic avatar from the nickname
  const [p] = await db
    .insert(participants)
    .values({ sessionId: session.id, nickname, avatarSeed, clientToken })
    .returning({ id: participants.id })

  const slide = answersOpen(session) ? await currentSlide(session) : null
  return Response.json({
    clientToken,
    participantId: p.id,
    avatarSeed,
    status: session.status,
    index: session.currentSlideIndex,
    slide: slide && sanitizeSlide(slide),
    serverStartedAt: session.currentSlideStartedAt?.toISOString() ?? null,
    timeLimitMs: slide?.config.timeLimitMs ?? null,
  })
}
