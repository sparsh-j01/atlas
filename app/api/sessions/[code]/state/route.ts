import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants } from '@/lib/db/schema'
import { sanitizeSlide, SPIKE_QUESTION, SPIKE_SLIDE_ID } from '@/lib/realtime/question'
import { bad, findLiveSession } from '@/lib/realtime/session-util'

// Catch-up / reconnect: Broadcast is ephemeral, so a late joiner fetches current state.
// The slide is SANITIZED (no is_correct); score + alreadyAnswered are scoped to the
// caller's client_token (never another participant's).
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  // Reconnect token is a bearer secret — read it from the Authorization header, not the URL
  // query (which leaks into logs, browser history, and Referer). Clients send `Bearer <token>`.
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || null

  const session = await findLiveSession(code)
  if (!session) return bad(404, 'session not found')

  let score = 0
  let alreadyAnswered = false
  if (token) {
    const [p] = await db
      .select({ id: participants.id, score: participants.score })
      .from(participants)
      .where(and(eq(participants.sessionId, session.id), eq(participants.clientToken, token)))
      .limit(1)
    if (p) {
      score = p.score
      const [a] = await db
        .select({ id: answers.id })
        .from(answers)
        .where(
          and(
            eq(answers.sessionId, session.id),
            eq(answers.slideId, SPIKE_SLIDE_ID),
            eq(answers.participantId, p.id),
          ),
        )
        .limit(1)
      alreadyAnswered = Boolean(a)
    }
  }

  return Response.json({
    status: session.status,
    index: session.currentSlideIndex,
    slide: session.status === 'active' ? sanitizeSlide() : null,
    serverStartedAt: session.currentSlideStartedAt?.toISOString() ?? null,
    timeLimitMs: SPIKE_QUESTION.timeLimitMs,
    score,
    alreadyAnswered,
  })
}
