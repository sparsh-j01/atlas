import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { correctOptionId } from '@/lib/mcq'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { sanitizeSlide, slideAt, slideCount, tallySlideAnswers } from '@/lib/realtime/live-slide'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { getHostedSession } from '@/lib/sessions'

// Host-only: move the room to a slide and start its clock. One endpoint covers start
// (index 0), next, back and skip — the caller names the TARGET index, so a double-click
// or a retried request lands on the same slide instead of skipping one.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  // A wrong/missing token 404s exactly like a wrong code: never confirm a session exists
  // to someone who can't host it.
  const session = await getHostedSession(code, await hostTokenFrom(req, code))
  if (!session) return bad(404, 'session not found')
  if (!session.deckId) return bad(409, 'session has no deck')

  const body = await req.json().catch(() => null)
  const index = body?.index
  const slide = Number.isInteger(index) ? await slideAt(session.deckId, index) : null
  if (!slide) return bad(400, 'index must be a valid slide index')

  // Going BACK to a slide whose answer was already disclosed must not reopen scoring: the
  // correct option is public by then, so anyone who sat that question out could submit it
  // for full points. Re-show it in its revealed state instead — which is what a host going
  // back to discuss a question actually wants — and answersOpen() keeps the window shut.
  const alreadyRevealed = session.revealedSlideIds.includes(slide.id)
  const startedAt = new Date()
  await db
    .update(sessions)
    .set({
      currentSlideIndex: index,
      currentSlideStartedAt: startedAt,
      status: alreadyRevealed ? 'revealed' : 'active',
      lastBcast: null, // fresh leaky-bucket window, so the new slide's first answer broadcasts
    })
    .where(eq(sessions.id, session.id))

  const status = alreadyRevealed ? 'revealed' : 'active'
  const payload = {
    index,
    slide: sanitizeSlide(slide),
    serverStartedAt: startedAt.toISOString(),
    timeLimitMs: slide.config.timeLimitMs,
    // Carried so a client can't briefly render a revealed slide as answerable while it
    // waits for the slide:reveal that follows.
    status,
  }
  await broadcast(code, EVENTS.SLIDE_SHOW, payload)

  const aggregate = alreadyRevealed ? await tallySlideAnswers(session.id, slide.id) : null
  const correct = alreadyRevealed ? correctOptionId(slide.config) : null
  if (alreadyRevealed) {
    // Re-disclose so the room sees the results it was already shown, not a blank slide.
    await broadcast(code, EVENTS.SLIDE_REVEAL, {
      slideId: slide.id,
      correctOptionId: correct ?? undefined,
      aggregate,
    })
  }

  // The host gets the slide back rather than waiting on its own broadcast — the console
  // renders even if Realtime is slow or dropped it (broadcast is best-effort).
  return Response.json({
    ...payload,
    total: await slideCount(session.deckId),
    correctOptionId: correct,
    aggregate,
  })
}
