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
