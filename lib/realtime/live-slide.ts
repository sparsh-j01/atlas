import 'server-only'
import { asc, eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sessions, slides } from '@/lib/db/schema'
import { sanitizeOptions } from '@/lib/mcq'
import { pointsOf, type SlideConfig } from '@/lib/slides'
import type { SanitizedSlide } from './events'

// The live session's view of a saved slide — replaces the M1 hardcoded question, so every
// route now reads prompt/options/answer-key off the deck row the host launched.
// `server-only` keeps `is_correct` physically un-importable from a client bundle; clients
// only ever see what sanitizeSlide() returns, and only until the host reveals.

export type LiveSlide = { id: string; type: string; prompt: string; config: SlideConfig }

const liveColumns = {
  id: slides.id,
  type: slides.type,
  prompt: slides.prompt,
  config: slides.config,
}

// Presentation order, defined once. The room is SHOWN slides from the launch snapshot
// (session-progress.ts → sessionSlides, sorted by position) and currentSlideLateral picks
// the slide an answer is JUDGED against from the live deck. The two agree because a deck
// cannot be edited while one of its sessions is open (assertDeckEditable in lib/decks.ts)
// and both order by position, which (deck_id, position) keeps unique.
const presentationOrder = asc(slides.position)

/** The deck's slide at `index` in presentation order, or null past the end.
 *  Ordered-offset rather than `position = index`: deleting a slide leaves a gap in
 *  `position` (lib/decks.ts doesn't renumber), so the nth slide isn't necessarily
 *  position n — and the session tracks an nth-slide index. */
export async function slideAt(deckId: string, index: number): Promise<LiveSlide | null> {
  if (!Number.isInteger(index) || index < 0) return null
  const [row] = await db
    .select(liveColumns)
    .from(slides)
    .where(eq(slides.deckId, deckId))
    .orderBy(presentationOrder)
    .limit(1)
    .offset(index)
  return row ?? null
}

/** currentSlide() as a LATERAL subquery, for a query that already has `sessions` in FROM —
 *  so the answer route reads room, caller and live slide in one round trip instead of three.
 *  Join it with `eq(sub.index, sessions.currentSlideIndex)`. The same nth-in-presentation-order
 *  rule as slideAt, so gaps in `position` are fine; the lobby's -1 and an index past the end
 *  match no row (the left join comes back null), and a deck-less session has no slides. */
export function currentSlideLateral() {
  return db
    .select({ ...liveColumns, index: sql<number>`row_number() over (order by ${presentationOrder}) - 1`.as('index') })
    .from(slides)
    .where(eq(slides.deckId, sessions.deckId))
    .as('live_slide')
}

/** The slide a session is on, or null when it has none (lobby, past the end, or a
 *  deck-less session row left over from the M1 spike). */
export function currentSlide(session: {
  deckId: string | null
  currentSlideIndex: number
}): Promise<LiveSlide | null> {
  if (!session.deckId) return Promise.resolve(null)
  return slideAt(session.deckId, session.currentSlideIndex)
}

/** The slide as clients may see it BEFORE reveal — the answer key is stripped. */
export function sanitizeSlide(s: LiveSlide): SanitizedSlide {
  return {
    id: s.id,
    type: s.type,
    prompt: s.prompt,
    options: sanitizeOptions(s.config),
    points: pointsOf(s.config),
  }
}
