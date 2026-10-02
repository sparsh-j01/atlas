// Broadcast event contracts (server → clients) on a session channel.
// Spec: docs/schema.md → "Realtime contracts". Anti-cheat: slide:show is sanitized
// server-side; is_correct never goes out on the wire. A student sees the answer key only in
// their own review, fetched from /state after the session has ended.

export const EVENTS = {
  SLIDE_SHOW: 'slide:show',
  LEADERBOARD_UPDATE: 'leaderboard:update', // host channel only
  SESSION_ENDED: 'session:ended',
  PARTICIPANT_KICKED: 'participant:kicked',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

// --- Payloads ---
// Client-safe slide shape — the answer key (is_correct) is stripped server-side before
// this ever leaves the server. This is all a client sees of a question during the quiz.
export interface SanitizedSlide {
  id: string
  type: string
  prompt: string
  options: { id: string; text: string }[]
  points: number
}

export interface LeaderboardEntry {
  participantId: string
  nickname: string
  avatarSeed: string
  score: number
  rank: number
}
// Host removed someone. Sent to the whole room because Broadcast has no per-client
// addressing; only the phone whose participantId matches acts on it. Carries no reason and
// no nickname — the removed name is the thing the host was trying to get off the screen.
export interface ParticipantKickedPayload {
  participantId: string
}
