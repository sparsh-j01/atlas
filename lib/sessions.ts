import 'server-only'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'
import { getDeckWithSlides } from '@/lib/decks'
import { isUniqueViolation, newCode, newToken } from '@/lib/realtime/session-util'
import { timingSafeEqual } from 'node:crypto'

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** Why a deck can't go live yet, or null if it can. A `ready` deck is already all-valid
 *  (setDeckStatusAction gates that), so this is the belt-and-suspenders launch gate. */
export function launchBlockedReason(status: string, slideCount: number): string | null {
  if (status !== 'ready') return 'Mark the deck ready before presenting it.'
  if (slideCount === 0) return 'Add at least one slide first.'
  return null
}

type Launched = { sessionId: string; code: string; hostToken: string }

/** The deck's live room, if it already has one. */
async function liveSessionForDeck(deckId: string): Promise<Launched | null> {
  const [row] = await db
    .select({ id: sessions.id, code: sessions.code, hostToken: sessions.hostToken })
    .from(sessions)
    .where(and(eq(sessions.deckId, deckId), ne(sessions.status, 'ended')))
    .limit(1)
  return row ? { sessionId: row.id, code: row.code, hostToken: row.hostToken } : null
}

/** Open a lobby session for one of the host's ready decks. Returns the join code and the
 *  host token that authorizes advance/reveal. Throws a user-facing message if the deck
 *  isn't the host's or isn't launchable.
 *
 *  A deck gets at most ONE live room: a double-clicked Present would otherwise open a
 *  second session with its own code and roster, and ending one would leave the deck locked
 *  by the other. Both the pre-check and the `sessions_active_deck_idx` violation resume the
 *  existing room rather than failing — the host lands where the students already are.
 *  Code uniqueness among live sessions is its own partial index; that collision is a real
 *  retry, so the two are told apart by constraint name. */
export async function createSessionFromDeck(deckId: string, hostId: string): Promise<Launched> {
  const dw = await getDeckWithSlides(deckId, hostId)
  if (!dw) throw new Error('deck not found')
  const blocked = launchBlockedReason(dw.deck.status, dw.slides.length)
  if (blocked) throw new Error(blocked)

  const running = await liveSessionForDeck(deckId)
  if (running) return running

  const hostToken = newToken()
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db
        .insert(sessions)
        .values({ deckId, hostId, code: newCode(), hostToken, status: 'lobby' })
        .returning({ id: sessions.id, code: sessions.code })
      return { sessionId: row.id, code: row.code, hostToken }
    } catch (e) {
      if (isUniqueViolation(e, 'sessions_active_code_idx')) continue // collision — draw another
      if (isUniqueViolation(e, 'sessions_active_deck_idx')) {
        // Lost a concurrent launch by a hair; join the room the other request opened.
        const winner = await liveSessionForDeck(deckId)
        if (winner) return winner
      }
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
    .where(and(eq(sessions.code, code), ne(sessions.status, 'ended')))
    .limit(1)
  if (!row) return null
  
  // Constant-time comparison to prevent timing attacks
  if (!constantTimeEqual(row.hostToken, hostToken)) return null
  
  return row
}
