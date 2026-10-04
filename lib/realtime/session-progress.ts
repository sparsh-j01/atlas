import 'server-only'
import { and, asc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants, sessions, slides } from '@/lib/db/schema'
import { rankLeaderboard } from './aggregate'
import { broadcast, broadcastToHost } from './broadcast'
import { EVENTS, type LeaderboardEntry, type SanitizedSlide } from './events'
import { sanitizeSlide } from './live-slide'
import { ANSWER_GRACE_MS } from './session-state'
import type { SlideRow } from '@/lib/results'

export type ProgressState = {
  status: string
  index: number
  slide: SanitizedSlide | null
  serverStartedAt: string | null
  timeLimitMs: number | null
  total: number
  leaderboard: LeaderboardEntry[]
}

type Session = typeof sessions.$inferSelect
export type ExpectedQuestion = { index: number; serverStartedAt: string }

/** Milliseconds until `expected` is due by the SERVER clock (0 = due now), or null when it is
 *  not the live question any more (moved on, ended, or never was). */
export function msUntilDue(session: Pick<Session, 'status' | 'currentSlideIndex' | 'currentSlideStartedAt'>, expected: ExpectedQuestion, timeLimitMs: number, now: number): number | null {
  const live = session.status === 'active' && session.currentSlideIndex === expected.index &&
    session.currentSlideStartedAt?.toISOString() === expected.serverStartedAt
  return live ? Math.max(0, session.currentSlideStartedAt!.getTime() + timeLimitMs + ANSWER_GRACE_MS - now) : null
}

export function questionDue(session: Pick<Session, 'status' | 'currentSlideIndex' | 'currentSlideStartedAt'>, expected: ExpectedQuestion, timeLimitMs: number, now: number) {
  return msUntilDue(session, expected, timeLimitMs, now) === 0
}

export async function sessionSlides(session: Session, executor: Pick<typeof db, 'select'> = db): Promise<SlideRow[]> {
  if (session.slideSnapshot) return [...session.slideSnapshot].sort((a, b) => a.position - b.position)
  if (!session.deckId) return []
  return executor.select({ id: slides.id, type: slides.type, prompt: slides.prompt, config: slides.config, position: slides.position })
    .from(slides).where(eq(slides.deckId, session.deckId)).orderBy(asc(slides.position))
}

export async function readProgressState(session: Session): Promise<ProgressState> {
  const [deckSlides, people] = await Promise.all([
    sessionSlides(session),
    db.select({ participantId: participants.id, nickname: participants.nickname, avatarSeed: participants.avatarSeed, score: participants.score })
      .from(participants).where(eq(participants.sessionId, session.id)),
  ])
  const slide = session.status === 'active' ? deckSlides[session.currentSlideIndex] : null
  return {
    status: session.status,
    index: session.currentSlideIndex,
    slide: slide ? sanitizeSlide(slide) : null,
    serverStartedAt: session.currentSlideStartedAt?.toISOString() ?? null,
    timeLimitMs: slide?.config.timeLimitMs ?? null,
    total: deckSlides.length,
    leaderboard: rankLeaderboard(people, people.length),
  }
}

/** Browsers wake the server at the deadline; only the server clock can move the room.
 * Locking the session makes simultaneous host/student retries advance exactly once.
 * Answer writes hold a shared session lock, so scoring finishes before this snapshot.
 *
 * `seen` is the row the route already read. A wake that is EARLY gets back how long to wait,
 * by this clock, with no lock and no further reads: a phone whose clock runs fast used to
 * retry every second for the whole question, each retry taking the exclusive lock every
 * answer in the room needs. A wake for a question that already moved on gets the current
 * state, which is how a phone that missed the broadcast catches up. */
export async function progressSession(seen: Session, expected: ExpectedQuestion): Promise<ProgressState | { waitMs: number } | null> {
  const seenSlides = await sessionSlides(seen)
  const live = seenSlides[seen.currentSlideIndex]
  const wait = live ? msUntilDue(seen, expected, live.config.timeLimitMs, Date.now()) : null
  if (wait === null) return readProgressState(seen)
  if (wait > 0) return { waitMs: wait }

  const sessionId = seen.id
  const result = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(sessions).where(eq(sessions.id, sessionId)).for('update')
    if (!session) return null
    const deckSlides = await sessionSlides(session, tx)
    const current = deckSlides[session.currentSlideIndex]
    const due = current && questionDue(session, expected, current.config.timeLimitMs, Date.now())
    if (!due) return { session, changed: false }

    const nextIndex = session.currentSlideIndex + 1
    const ended = nextIndex >= deckSlides.length
    const startedAt = new Date()
    const shown = [...new Set([...session.revealedSlideIds, current.id])]
    const [updated] = await tx.update(sessions).set({
      status: ended ? 'ended' : 'active',
      currentSlideIndex: ended ? session.currentSlideIndex : nextIndex,
      currentSlideStartedAt: ended ? session.currentSlideStartedAt : startedAt,
      endedAt: ended ? startedAt : null,
      revealedSlideIds: shown,
      slideSnapshot: deckSlides,
    }).where(and(eq(sessions.id, session.id), eq(sessions.status, session.status), eq(sessions.currentSlideIndex, expected.index)))
      .returning()
    return updated ? { session: updated, changed: true } : { session, changed: false }
  })
  if (!result) return null
  const state = await readProgressState(result.session)
  if (!result.changed) return state

  // A delayed response/broadcast for an older question must not replace a newer screen.
  const completedIndex = expected.index
  const code = result.session.code
  // ONE room broadcast per transition, in parallel with the host's. Supabase meters Realtime
  // per delivered copy: a leaderboard:update AND a slide:show to 120 phones in the same
  // second was 240 msg/s against Free's 100/s, where clients get disconnected (load test
  // 2026-10-05), and no phone displayed that leaderboard. Each publish is also its own HTTP
  // call, so sequential ones were most of the ~2 s before phones saw the next question.
  await Promise.all([
    broadcastToHost(code, EVENTS.LEADERBOARD_UPDATE, { top: state.leaderboard, completedIndex }),
    state.status === 'ended'
      ? broadcast(code, EVENTS.SESSION_ENDED, { fullRanking: state.leaderboard })
      // No answer key or explanation goes out between questions: the review is available only
      // after the session ends, through the participant's authenticated state request.
      : broadcast(code, EVENTS.SLIDE_SHOW, {
        index: state.index, slide: state.slide, status: 'active', total: state.total,
        serverStartedAt: state.serverStartedAt, timeLimitMs: state.timeLimitMs,
      }),
  ])
  return state
}
