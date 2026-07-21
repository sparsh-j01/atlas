import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { sanitizeSlide, SPIKE_QUESTION } from '@/lib/realtime/question'
import { bad, isUniqueViolation, newCode, newToken } from '@/lib/realtime/session-util'

// M1 spike: create a session and go straight to the single hardcoded question live.
// (Lobby → deck-driven advance is M3; here start == show-the-one-slide.)
export async function POST() {
  const hostToken = newToken()

  let row: typeof sessions.$inferSelect | undefined
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      ;[row] = await db
        .insert(sessions)
        .values({
          code: newCode(),
          status: 'active',
          hostToken,
          currentSlideIndex: 0,
          currentSlideStartedAt: new Date(),
        })
        .returning()
      break
    } catch (e) {
      if (isUniqueViolation(e) && attempt < 4) continue // code collided with a live session
      throw e
    }
  }
  if (!row) return bad(500, 'could not allocate a session code')

  const slide = sanitizeSlide()
  const serverStartedAt = row.currentSlideStartedAt!.toISOString()
  const timeLimitMs = SPIKE_QUESTION.timeLimitMs

  await broadcast(row.code, EVENTS.SLIDE_SHOW, { index: 0, slide, serverStartedAt, timeLimitMs })

  return Response.json({ code: row.code, hostToken, slide, serverStartedAt, timeLimitMs })
}
