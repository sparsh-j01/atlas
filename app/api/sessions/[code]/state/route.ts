import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, participants, sessions } from '@/lib/db/schema'
import { isRoomCode, isUuid } from '@/lib/ids'
import { currentSlide, sanitizeSlide } from '@/lib/realtime/live-slide'
import { bad } from '@/lib/realtime/session-util'
import { getParticipantReview } from '@/lib/participant-review.server'

// Catch-up / reconnect: Broadcast is ephemeral, so a late joiner or a reloaded phone fetches
// current state instead of waiting for the next event. Mid-quiz the slide is SANITIZED (no
// is_correct key); once the session has ended the caller gets their own answer review.
// Everything is scoped to the caller's client_token — never another participant's.
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  // The token is a bearer secret, so it rides in the Authorization header, never the URL
  // (which leaks into logs, history and Referer). No valid token gets the same 404 as an
  // unknown code: a 200 for a live room and a 404 otherwise would let anyone find live
  // classes by guessing codes, with no trace in any roster.
  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() ?? ''
  if (!isRoomCode(code) || !isUuid(token)) return bad(404, 'session not found')

  // Resolve the seat as well as the code. Codes can be reused; a saved token still names
  // its original completed quiz, so reloading a review never opens somebody else's room.
  const [row] = await db.select({ session: sessions, participantId: participants.id, score: participants.score })
    .from(sessions)
    .innerJoin(participants, and(eq(participants.sessionId, sessions.id), eq(participants.clientToken, token)))
    .where(eq(sessions.code, code)).limit(1)
  if (!row) return bad(404, 'session not found')
  const { session, participantId, score } = row
  if (session.status === 'ended') {
    return Response.json({ status: 'ended', score, review: await getParticipantReview(session, participantId) },
      { headers: { 'Cache-Control': 'no-store' } })
  }
  const slide = await currentSlide(session)
  let myOptionId: string | null = null
  if (slide) {
    const [answer] = await db.select({ response: answers.response }).from(answers)
      .where(and(eq(answers.sessionId, session.id), eq(answers.slideId, slide.id), eq(answers.participantId, participantId))).limit(1)
    myOptionId = answer?.response.optionId ?? null
  }
  // No answer key and no explanation mid-quiz: those reach a student only in the review above.
  return Response.json({
    status: session.status, index: session.currentSlideIndex,
    slide: slide && sanitizeSlide(slide),
    serverStartedAt: session.currentSlideStartedAt?.toISOString() ?? null,
    timeLimitMs: slide?.config.timeLimitMs ?? null,
    total: session.slideSnapshot?.length ?? null,
    score, myOptionId,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
