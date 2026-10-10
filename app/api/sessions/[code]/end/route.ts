import { asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants, sessions, slides } from '@/lib/db/schema'
import { rankLeaderboard } from '@/lib/realtime/aggregate'
import { broadcast } from '@/lib/realtime/broadcast'
import { EVENTS } from '@/lib/realtime/events'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { getHostedSession } from '@/lib/sessions'
import { checkLimit, tooMany } from '@/lib/rate-limit'

// Host-only: close the room. Ending frees the 6-digit code for reuse (the unique index is
// partial on status <> 'ended') and unlocks the deck for editing again (lib/decks.ts).
// What lands here is the final ranking every client needs to render the end screen.
//
// CSRF is covered by the SameSite=Lax host-token cookie — see the advance route.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const session = await getHostedSession(code, await hostTokenFrom(req, code))
  if (!session) return bad(404, 'session not found')
  // Every host action fans out to every phone in the room — see LIMITS.hostActionPerSession.
  const paced = await checkLimit('hostActionPerSession', session.id)
  if (!paced.ok) return tooMany(paced.retryAfterSec)

  // Close the answer window FIRST, then snapshot. Reading scores before the flip would let
  // an answer commit in the gap: it lands in participants.score but misses the ranking we
  // broadcast, so the final ranking disagrees with what's persisted.
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(sessions).where(eq(sessions.id, session.id)).for('update')
    if (!locked || locked.status === 'ended') return
    const slide = locked.currentSlideIndex < 0 ? null : locked.slideSnapshot
      ? [...locked.slideSnapshot].sort((a, b) => a.position - b.position)[locked.currentSlideIndex]
      : locked.deckId ? (await tx.select({ id: slides.id }).from(slides).where(eq(slides.deckId, locked.deckId))
        .orderBy(asc(slides.position)).limit(1).offset(locked.currentSlideIndex))[0] : null
    await tx.update(sessions).set({
      status: 'ended', endedAt: new Date(),
      revealedSlideIds: slide ? [...new Set([...locked.revealedSlideIds, slide.id])] : locked.revealedSlideIds,
    }).where(eq(sessions.id, session.id))
  })

  const parts = await db
    .select({
      participantId: participants.id,
      nickname: participants.nickname,
      avatarSeed: participants.avatarSeed,
      score: participants.score,
    })
    .from(participants)
    .where(eq(participants.sessionId, session.id))
  const fullRanking = rankLeaderboard(parts, parts.length)

  await broadcast(code, EVENTS.SESSION_ENDED, { fullRanking })

  return Response.json({ ok: true, fullRanking })
}
