import 'server-only'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { getDeckWithSlides } from '@/lib/decks'
import { isUniqueViolation, newCode, newToken } from '@/lib/realtime/session-util'

/** Why a deck can't go live yet, or null if it can. A `ready` deck is already all-valid
 *  (setDeckStatusAction gates that), so this is the belt-and-suspenders launch gate. */
export function launchBlockedReason(status: string, slideCount: number): string | null {
  if (status !== 'ready') return 'Mark the deck ready before presenting it.'
  if (slideCount === 0) return 'Add at least one slide first.'
  return null
}

/** Open a lobby session for one of the host's ready decks. Returns the join code and the
 *  host token that authorizes advance/reveal. Throws a user-facing message if the deck
 *  isn't the host's or isn't launchable. Code uniqueness among live sessions is the partial
 *  unique index; we retry on the rare collision (same pattern as the spike start route). */
export async function createSessionFromDeck(
  deckId: string,
  hostId: string,
): Promise<{ sessionId: string; code: string; hostToken: string }> {
  const dw = await getDeckWithSlides(deckId, hostId)
  if (!dw) throw new Error('deck not found')
  const blocked = launchBlockedReason(dw.deck.status, dw.slides.length)
  if (blocked) throw new Error(blocked)

  const hostToken = newToken()
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(sessions)
        .values({ deckId, hostId, code: newCode(), hostToken, status: 'lobby' })
        .returning({ id: sessions.id, code: sessions.code })
      return { sessionId: row.id, code: row.code, hostToken }
    } catch (e) {
      if (isUniqueViolation(e)) continue // live-code collision — draw another
      throw e
    }
  }
  throw new Error('could not allocate a session code')
}

/** The live session for a code, but only if the caller holds its host token — the server
 *  side of the httpOnly cookie set at launch. Empty token matches nothing (host_token is
 *  always a uuid), so a non-host gets null → 404. */
export async function getHostedSession(code: string, hostToken: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.code, code), eq(sessions.hostToken, hostToken), ne(sessions.status, 'ended')))
    .limit(1)
  return row ?? null
}
