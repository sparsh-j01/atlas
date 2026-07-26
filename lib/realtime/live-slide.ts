import 'server-only'
import { and, asc, count, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, slides } from '@/lib/db/schema'
import { sanitizeOptions, type McqConfig } from '@/lib/mcq'
import { tallyMcq } from './aggregate'
import type { AggregateMcq, SanitizedSlide } from './events'

// The live session's view of a saved slide — replaces the M1 hardcoded question, so every
// route now reads prompt/options/answer-key off the deck row the host launched.
// `server-only` keeps `is_correct` physically un-importable from a client bundle; clients
// only ever see what sanitizeSlide() returns, and only until the host reveals.

export type LiveSlide = { id: string; type: string; prompt: string; config: McqConfig }

const liveColumns = {
  id: slides.id,
  type: slides.type,
  prompt: slides.prompt,
  config: slides.config,
}

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
    .orderBy(asc(slides.position))
    .limit(1)
    .offset(index)
  return row ?? null
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

export async function slideCount(deckId: string): Promise<number> {
  const [row] = await db.select({ n: count() }).from(slides).where(eq(slides.deckId, deckId))
  return row.n
}

/** Count the responses to one slide. Computed on read — no stored counter, so there's no
 *  concurrent-increment race. Shared by reveal and by advance re-showing a revealed slide. */
export async function tallySlideAnswers(sessionId: string, slideId: string): Promise<AggregateMcq> {
  const rows = await db
    .select({ response: answers.response })
    .from(answers)
    .where(and(eq(answers.sessionId, sessionId), eq(answers.slideId, slideId)))
  return tallyMcq(rows.map((r) => ({ optionId: r.response.optionId })))
}

/** The slide as clients may see it BEFORE reveal — the answer key is stripped. */
export function sanitizeSlide(s: LiveSlide): SanitizedSlide {
  return {
    id: s.id,
    type: s.type,
    prompt: s.prompt,
    options: sanitizeOptions(s.config),
    points: s.config.points,
  }
}
