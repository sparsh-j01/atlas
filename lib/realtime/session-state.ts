// The anti-cheat gate for answer submission. Answers are open ONLY while the question is
// live — status 'active' with a started clock. Once the host reveals (status flips to
// 'revealed', which broadcasts correctOptionId) or the session ends, the window is closed,
// so a participant still inside their per-answer timer can't read the revealed correct
// option and submit it for credit. Kept dependency-free (no db/server-only) so it stays a
// pure, unit-testable predicate shared by the answer route and future advance logic.
export function answersOpen<T extends { status: string; currentSlideStartedAt: Date | null }>(
  session: T,
): session is T & { currentSlideStartedAt: Date } {
  return session.status === 'active' && session.currentSlideStartedAt != null
}

/**
 * Slack on the per-slide deadline, to cover the trip the tap makes over the network.
 *
 * The server judges by its own receipt time, which is right — a client-sent timestamp is
 * forgeable. But receipt time includes the upload, so a player who taps at 19.8s on mobile
 * data can arrive at 20.2s and be told they were too slow. That is the one rejection a
 * player notices out loud, because from where they sat they made it.
 *
 * Safe to give away: `scoreAnswer` clamps the speed ratio to [0,1], so an answer inside the
 * grace scores the FLOOR (base * (1 - SPEED_FACTOR)), never more. Nobody can gain by
 * answering late — the grace only turns "rejected" into "accepted, slowest possible score".
 * The reveal-gate is untouched: once the host reveals, `answersOpen` is false and nothing
 * here is reached, so the answer key still can't be read and then submitted.
 */
export const ANSWER_GRACE_MS = 750

export function withinAnswerWindow(responseMs: number, timeLimitMs: number): boolean {
  return responseMs <= timeLimitMs + ANSWER_GRACE_MS
}
