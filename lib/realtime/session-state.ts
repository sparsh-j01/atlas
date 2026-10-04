// The gate for answer submission. Answers are open ONLY while a question is live — status
// 'active' with a started clock — never in the lobby or after the end, when the review has
// put every answer key on the participants' phones. Each question's own deadline is
// withinAnswerWindow below. Kept dependency-free (no db/server-only) so it stays a pure,
// unit-testable predicate.
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
 * No answer key is public while a question is open (the review comes after the end), so
 * the grace cannot be used to read the key and then submit it.
 */
export const ANSWER_GRACE_MS = 750

export function withinAnswerWindow(responseMs: number, timeLimitMs: number): boolean {
  return responseMs <= timeLimitMs + ANSWER_GRACE_MS
}
