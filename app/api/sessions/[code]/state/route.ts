import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants } from '@/lib/db/schema'
import { correctOptionId } from '@/lib/mcq'
import { explanationOf } from '@/lib/slides'
import { currentSlide, sanitizeSlide } from '@/lib/realtime/live-slide'
import { bad, findLiveSession } from '@/lib/realtime/session-util'

// Catch-up / reconnect: Broadcast is ephemeral, so a late joiner or a reloaded phone fetches
// current state instead of waiting for the next event. The slide is SANITIZED (no is_correct
// key); the correct option is disclosed only once the host has revealed it. Score and the
// caller's own pick are scoped to their client_token — never another participant's.
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  // Reconnect token is a bearer secret — read it from the Authorization header, not the URL
  // query (which leaks into logs, browser history, and Referer). Clients send `Bearer <token>`.
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null

  const session = await findLiveSession(code)
  if (!session) return bad(404, 'session not found')

  const slide = await currentSlide(session)
  const revealed = session.status === 'revealed'

  let score = 0
  let myOptionId: string | null = null
  if (token) {
    const [p] = await db
      .select({ id: participants.id, score: participants.score })
      .from(participants)
      .where(and(eq(participants.sessionId, session.id), eq(participants.clientToken, token)))
      .limit(1)
    // A token that names nobody in THIS session is not a seat. Codes are reusable once a
    // session ends (sessions_active_code_idx), so a phone that was offline when the last
    // game closed still holds a token for a code that now belongs to a different room —
    // and this used to answer 200 with score 0, so that phone rendered the new game's
    // slides and only discovered it wasn't playing when its first answer came back 403.
    // 404, same as a wrong code: never confirm a room exists to someone who isn't in it.
    if (!p) return bad(404, 'session not found')
    score = p.score
    if (slide) {
      const [a] = await db
        .select({ response: answers.response })
        .from(answers)
        .where(
          and(
            eq(answers.sessionId, session.id),
            eq(answers.slideId, slide.id),
            eq(answers.participantId, p.id),
          ),
        )
        .limit(1)
      myOptionId = a?.response.optionId ?? null
    }
  }

  return Response.json({
    status: session.status,
    index: session.currentSlideIndex,
    slide: slide && sanitizeSlide(slide),
    serverStartedAt: session.currentSlideStartedAt?.toISOString() ?? null,
    timeLimitMs: slide?.config.timeLimitMs ?? null,
    correctOptionId: revealed && slide ? correctOptionId(slide.config) : null,
    // Same gate as the answer key: reconnecting mid-reveal restores the explanation,
    // reconnecting mid-question must not.
    explanation: revealed && slide ? (explanationOf(slide.config) ?? null) : null,
    score,
    myOptionId,
  })
}
