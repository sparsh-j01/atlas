import { db } from '@/lib/db'
import { participants } from '@/lib/db/schema'
import { sanitizeSlide, SPIKE_QUESTION } from '@/lib/realtime/question'
import { bad, findLiveSession, newToken } from '@/lib/realtime/session-util'

// Anonymous participant join. Issues the SERVER-side client_token (identity); a
// client-set token is never trusted. Returns the sanitized slide so the player can render
// immediately without racing the slide:show broadcast.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const body = await req.json().catch(() => null)
  const nickname = typeof body?.nickname === 'string' ? body.nickname.trim() : ''
  if (!nickname || nickname.length > 24) return bad(400, 'nickname must be 1–24 characters')

  const session = await findLiveSession(code)
  if (!session) return bad(404, 'session not found')

  const clientToken = newToken()
  const avatarSeed = nickname // DiceBear seed; deterministic avatar from the nickname
  const [p] = await db
    .insert(participants)
    .values({ sessionId: session.id, nickname, avatarSeed, clientToken })
    .returning({ id: participants.id })

  return Response.json({
    clientToken,
    participantId: p.id,
    avatarSeed,
    slide: session.status === 'active' ? sanitizeSlide() : null,
    serverStartedAt: session.currentSlideStartedAt?.toISOString() ?? null,
    timeLimitMs: SPIKE_QUESTION.timeLimitMs,
  })
}
