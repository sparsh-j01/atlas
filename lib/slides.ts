// The slide-type union and its per-type dispatch — the one place that knows every slide
// type exists. Pure, client+server safe.
//
// Kept out of lib/mcq.ts so that module stays MCQ-only and lib/poll.ts can import from it
// without a cycle: mcq ← poll, and both ← slides. Nothing in mcq/poll imports this file.
//
// There is deliberately no discriminated union on the *config* — no `kind` field baked into
// the jsonb. `slides.type` is already the discriminant, it's already a column, and the two
// places a caller genuinely needs a type-specific field are covered by pointsOf/
// explanationOf below. Adding a second, redundant discriminant would need a migration to
// backfill every existing row for nothing.
import { blankMcq, toStored, validateMcq, type EditableMcq, type McqConfig } from './mcq'
import { blankPoll, toStoredPoll, validatePoll, type EditablePoll, type PollConfig } from './poll'

export const SLIDE_TYPES = ['quiz_mcq', 'poll'] as const
export type SlideType = (typeof SLIDE_TYPES)[number]

export type SlideConfig = McqConfig | PollConfig

// The draft carries its own type, so every dispatch below narrows on it instead of taking a
// separate `type` argument the compiler can't relate to the payload (which would need casts
// — and a cast is exactly where a poll draft would get validated as an MCQ).
export type EditableSlide =
  | ({ type: 'quiz_mcq' } & EditableMcq)
  | ({ type: 'poll' } & EditablePoll)

export const SLIDE_TYPE_LABEL: Record<SlideType, string> = {
  quiz_mcq: 'Quiz question',
  poll: 'Poll',
}

export function isSlideType(v: unknown): v is SlideType {
  return typeof v === 'string' && (SLIDE_TYPES as readonly string[]).includes(v)
}

/**
 * Whether this slide type awards points — and therefore whether its running tally has to
 * stay hidden until the reveal. The two are the same rule, not a coincidence: broadcasting
 * live counts on a scored question lets the room herd toward whatever is winning, which is
 * why M4 deliberately left `results:update` unused. A poll has no answer to protect, so it
 * gets the live feed and the quiz keeps the bare `answered:count`.
 *
 * Takes a plain string because the callers hold `slides.type` (free text from the DB) or
 * `SanitizedSlide.type` (over the wire) — an unknown type falls to the safe side, unscored.
 */
export function isScored(type: string): boolean {
  return type === 'quiz_mcq'
}

/** What a correct answer is worth. A poll is unscored, so 0 — which is why the answer route
 *  needs no branch to keep poll answers off the leaderboard. */
export function pointsOf(c: SlideConfig): number {
  return 'points' in c ? c.points : 0
}

/** Post-reveal teaching copy, if the type has any. Read through here rather than
 *  `config.explanation` because a poll config has no such property at all — and an MCQ
 *  saved without one has no key either, so `in` is the honest check for both. */
export function explanationOf(c: SlideConfig): string | undefined {
  return 'explanation' in c ? c.explanation : undefined
}

export function blankSlide(type: SlideType): EditableSlide {
  return type === 'poll' ? { type, ...blankPoll() } : { type, ...blankMcq() }
}

export function validateSlide(d: EditableSlide): string[] {
  return d.type === 'poll' ? validatePoll(d) : validateMcq(d)
}

export function toStoredSlide(d: EditableSlide): { prompt: string; config: SlideConfig } {
  return d.type === 'poll' ? toStoredPoll(d) : toStored(d)
}

/**
 * A stored row back into the draft shape the validators take — used by the deck ready-gate,
 * which re-validates every saved slide before a deck can go live.
 *
 * Returns null when `type` and `config` disagree, because nothing in the database enforces
 * that pairing: `config` is jsonb and `type` is free text, so a row written by a future
 * migration, a hand-run SQL statement, or M6's generator could hold a poll config under a
 * quiz type. Treating that as "invalid slide" keeps it out of a live room instead of
 * crashing mid-game on a missing field.
 */
export function toEditable(s: {
  type: string
  prompt: string
  config: SlideConfig
}): EditableSlide | null {
  if (s.type === 'poll' && 'chart' in s.config) return { type: 'poll', prompt: s.prompt, ...s.config }
  if (s.type === 'quiz_mcq' && 'points' in s.config)
    return { type: 'quiz_mcq', prompt: s.prompt, ...s.config }
  return null
}
