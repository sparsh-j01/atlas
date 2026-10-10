import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { sanitizeSlide } from '@/lib/realtime/live-slide'
import { sessionSlides } from '@/lib/realtime/session-progress'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { getHostedSession } from '@/lib/sessions'
import { checkLimit, tooMany } from '@/lib/rate-limit'

// Host-only: start the quiz. It runs once, from the lobby onto the first question; after
// that the room moves itself, each deadline handled by /progress.
//
// CSRF: the credential here is the `htk_<code>` cookie, set SameSite=Lax in
// lib/actions.ts. Browsers do not attach a Lax cookie to a cross-site POST, and this
// route is POST-only, so a forged submission arrives with no host token and 404s like
// any other bad token. That IS the CSRF control — don't add a token layer on top of it.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  // A wrong/missing token 404s exactly like a wrong code: never confirm a session exists
  // to someone who can't host it.
  const session = await getHostedSession(code, await hostTokenFrom(req, code))
  if (!session) return bad(404, 'session not found')
  // Every host action fans out to every phone in the room — see LIMITS.hostActionPerSession.
  const paced = await checkLimit('hostActionPerSession', session.id)
  if (!paced.ok) return tooMany(paced.retryAfterSec)

  // The launch snapshot, the same list /progress walks, so question 1 is the one the review
  // and the results will show even if the deck was edited after launch.
  const slides = await sessionSlides(session)
  const slide = slides[0]
  if (!slide) return bad(409, 'session has no questions')
  const startedAt = new Date()

  // Compare-and-set on 'lobby': a double click, a retry, or `end` committing between the
  // read above and this write must not restart a running room or resurrect a closed one.
  const applied = await db
    .update(sessions)
    .set({ currentSlideIndex: 0, currentSlideStartedAt: startedAt, status: 'active' })
    .where(and(eq(sessions.id, session.id), eq(sessions.status, 'lobby')))
    .returning({ id: sessions.id })
  if (applied.length === 0) return bad(409, 'session already started')

  const payload = {
    index: 0,
    slide: sanitizeSlide(slide),
    serverStartedAt: startedAt.toISOString(),
    timeLimitMs: slide.config.timeLimitMs,
    status: 'active' as const,
    total: slides.length,
  }
  await broadcast(code, EVENTS.SLIDE_SHOW, payload)
  // The host gets the slide back rather than waiting on its own broadcast — the console
  // renders even if Realtime is slow or dropped it (broadcast is best-effort).
  return Response.json(payload)
}
