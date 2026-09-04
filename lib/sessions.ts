import 'server-only'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { answers, decks, participants, sessions, slides } from '@/lib/db/schema'
import { getDeckWithSlides } from '@/lib/decks'
import { isUniqueViolation, newCode, newToken } from '@/lib/realtime/session-util'
import { shapeResults, type SessionResults } from '@/lib/results'
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

// --- Post-session results (M9) -------------------------------------------------------
//
// Keyed by session id, never by code: `sessions_active_code_idx` is partial on
// `status <> 'ended'`, so a 6-digit code is released for reuse the moment a session ends and
// two finished sessions can share one. The code identifies a LIVE room; the id identifies a
// game that happened.
//
// Ownership is `hostId = ownerId` on the session row itself rather than a join through the
// deck, because `sessions.deck_id` is ON DELETE SET NULL — results have to stay reachable
// after the deck is gone, which is exactly when a deck join would stop matching.

export type SessionListItem = {
  id: string
  deckId: string | null
  deckTitle: string | null
  endedAt: Date | null
  createdAt: Date
  players: number
}

/** The creator's finished sessions, newest first. */
export function listEndedSessions(ownerId: string): Promise<SessionListItem[]> {
  return db
    .select({
      id: sessions.id,
      deckId: sessions.deckId,
      deckTitle: decks.title,
      endedAt: sessions.endedAt,
      createdAt: sessions.createdAt,
      // Correlated subquery rather than a group-by join: a join through participants would
      // multiply the session row and needs a GROUP BY over every selected column. `::int`
      // because count(*) is bigint, which postgres.js returns as a string (see lib/decks.ts).
      players: sql<number>`(select count(*)::int from ${participants}
                            where ${participants.sessionId} = ${sessions.id})`,
    })
    .from(sessions)
    .leftJoin(decks, eq(decks.id, sessions.deckId))
    .where(and(eq(sessions.hostId, ownerId), eq(sessions.status, 'ended')))
    .orderBy(desc(sessions.endedAt), desc(sessions.createdAt))
}

export type SessionResultsPage = {
  session: { id: string; code: string; endedAt: Date | null; createdAt: Date }
  deckId: string | null
  deckTitle: string | null
  results: SessionResults
}

/**
 * One finished session's full results, or null if it is not this creator's (or not over).
 *
 * Restricted to ended sessions on purpose: a live room's numbers belong on the host console,
 * which is authoritative and updating, and a second half-finished view of the same game is a
 * way to read a stale score and act on it.
 */
export async function getSessionResults(
  sessionId: string,
  ownerId: string,
): Promise<SessionResultsPage | null> {
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.id, sessionId),
        eq(sessions.hostId, ownerId),
        eq(sessions.status, 'ended'),
      ),
    )
    .limit(1)
  if (!session) return null

  // The deck may be gone (ON DELETE SET NULL). Both reads below are scoped by the session,
  // so they return the game's own rows either way.
  const deckRows = session.deckId
    ? await db
        .select({
          id: slides.id,
          type: slides.type,
          prompt: slides.prompt,
          config: slides.config,
          position: slides.position,
        })
        .from(slides)
        .where(eq(slides.deckId, session.deckId))
        .orderBy(asc(slides.position))
    : []

  const [deck] = session.deckId
    ? await db
        .select({ title: decks.title })
        .from(decks)
        .where(eq(decks.id, session.deckId))
        .limit(1)
    : []

  const people = await db
    .select({
      participantId: participants.id,
      nickname: participants.nickname,
      avatarSeed: participants.avatarSeed,
      score: participants.score,
    })
    .from(participants)
    .where(eq(participants.sessionId, sessionId))

  const rows = await db
    .select({
      slideId: answers.slideId,
      participantId: answers.participantId,
      response: answers.response,
      isCorrect: answers.isCorrect,
      pointsAwarded: answers.pointsAwarded,
      responseMs: answers.responseMs,
    })
    .from(answers)
    .where(eq(answers.sessionId, sessionId))

  return {
    session: {
      id: session.id,
      code: session.code,
      endedAt: session.endedAt,
      createdAt: session.createdAt,
    },
    deckId: session.deckId,
    deckTitle: deck?.title ?? null,
    results: shapeResults(
      deckRows,
      people,
      rows.map((r) => ({
        slideId: r.slideId,
        participantId: r.participantId,
        optionId: r.response.optionId,
        isCorrect: r.isCorrect,
        pointsAwarded: r.pointsAwarded,
        responseMs: r.responseMs,
      })),
      session.revealedSlideIds,
    ),
  }
}
