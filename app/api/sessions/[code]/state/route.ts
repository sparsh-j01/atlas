import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants } from '@/lib/db/schema'
import { correctOptionId } from '@/lib/mcq'
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
    if (p) {
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
    explanation: revealed && slide ? (slide.config.explanation ?? null) : null,
    score,
    myOptionId,
  })
}
