// Broadcast event contracts (server → clients) on a session channel.
// Spec: docs/schema.md → "Realtime contracts". Anti-cheat: slide:show and slide:reveal
// payloads are sanitized server-side; is_correct is never sent before the reveal.

export const EVENTS = {
  SLIDE_SHOW: 'slide:show',
  RESULTS_UPDATE: 'results:update',
  ANSWERED_COUNT: 'answered:count',
  SLIDE_REVEAL: 'slide:reveal',
  LEADERBOARD_UPDATE: 'leaderboard:update',
  SESSION_STATE: 'session:state',
  SESSION_ENDED: 'session:ended',
} as const

export type EventName = (typeof EVENTS)[keyof typeof EVENTS]

// --- Aggregates (live viz) ---
export interface AggregateMcq {
  counts: Record<string, number> // optionId -> count
  total: number
}
export interface AggregateWordCloud {
  words: { text: string; weight: number }[]
}
export type Aggregate = AggregateMcq | AggregateWordCloud

// --- Payloads ---
// Client-safe slide shape — the answer key (is_correct) is stripped server-side before
// this ever leaves the server. This is all a client is allowed to see before reveal.
export interface SanitizedSlide {
  id: string
  type: string
  prompt: string
  options: { id: string; text: string }[]
  points: number
}

export interface SlideShowPayload {
  index: number
  slide: SanitizedSlide
  serverStartedAt: string // ISO timestamp
  timeLimitMs: number
  // 'revealed' when the host re-shows a slide whose answer already went out — the window
  // stays shut. Without it a client would render the slide as answerable for the moment
  // between this event and the slide:reveal that follows.
  status: 'active' | 'revealed'
}

export interface ResultsUpdatePayload {
  slideId: string
  aggregate: Aggregate
}

export interface AnsweredCountPayload {
  slideId: string
  answered: number
  total: number
}

export interface SlideRevealPayload {
  slideId: string
  correctOptionId?: string
  aggregate: Aggregate
  explanation?: string
}

export interface LeaderboardEntry {
  participantId: string
  nickname: string
  avatarSeed: string
  score: number
  rank: number
  delta: number // change vs the last broadcast top-N
}
export interface LeaderboardUpdatePayload {
  top: LeaderboardEntry[]
}

export interface SessionStatePayload {
  status: 'lobby' | 'active' | 'revealed' | 'ended'
}

export interface SessionEndedPayload {
  podium: LeaderboardEntry[]
  fullRanking: LeaderboardEntry[]
}

// Presence (participant → channel): drives the lobby roster + live count.
export interface PresenceState {
  participantId: string
  nickname: string
  avatarSeed: string
}
