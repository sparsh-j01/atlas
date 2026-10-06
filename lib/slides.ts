// The slide-type union and its per-type dispatch — the one place that knows every slide
// type exists. Pure, client+server safe.
//
// Kept out of lib/mcq.ts so that module stays MCQ-only: mcq ← slides, never the reverse.
// Polls were removed 2026-10-05 (quiz only); the dispatch stays so a future type is a
// compile error at every switch below rather than a silent fall-through.
//
// There is deliberately no discriminated union on the *config* — no `kind` field baked into
// the jsonb. `slides.type` is already the discriminant, it's already a column, and the two
// places a caller genuinely needs a type-specific field are covered by pointsOf/
// explanationOf below. Adding a second, redundant discriminant would need a migration to
// backfill every existing row for nothing.
import { blankMcq, toStored, validateMcq, type EditableMcq, type McqConfig } from './mcq'

export const SLIDE_TYPES = ['quiz_mcq'] as const
export type SlideType = (typeof SLIDE_TYPES)[number]

export type SlideConfig = McqConfig

// The draft carries its own type, so every dispatch below narrows on it instead of taking a
// separate `type` argument the compiler can't relate to the payload.
export type EditableSlide = { type: 'quiz_mcq' } & EditableMcq

export const SLIDE_TYPE_LABEL: Record<SlideType, string> = {
  quiz_mcq: 'Quiz question',
}

export function isSlideType(v: unknown): v is SlideType {
  return typeof v === 'string' && (SLIDE_TYPES as readonly string[]).includes(v)
}

/**
 * Whether this slide type awards points. Every type does now that polls are gone; kept so a
 * row with an unknown `type` (free text in the DB, or over the wire) falls to the safe
 * side, unscored, rather than being graded against an answer key it doesn't have.
 */
export function isScored(type: string): boolean {
  return type === 'quiz_mcq'
}

/** What a correct answer is worth. */
export function pointsOf(c: SlideConfig): number {
  return c.points
}

/** Teaching copy, if the slide has any. An MCQ saved without one has no key at all. */
export function explanationOf(c: SlideConfig): string | undefined {
  return 'explanation' in c ? c.explanation : undefined
}

// Switches with no `default`, deliberately, and each one declares its return type. That
// combination is what makes adding a third SLIDE_TYPE a COMPILE error here (TS2366: the
// function can now fall off the end) instead of a silent fall-through into the MCQ branch.
// Word cloud is deferred, not cancelled, and a word_cloud draft quietly validated by the MCQ
// rules is exactly the kind of type/config mismatch toEditable() below exists to fail closed
// on — better to never let it be constructed.
export function blankSlide(type: SlideType): EditableSlide {
  switch (type) {
    case 'quiz_mcq':
      return { type, ...blankMcq() }
  }
}

// Postgres refuses a NUL byte in text and in jsonb alike, so a slide holding one would pass
// every rule below and then fail the save with a 500. Only a paste or a crafted request
// carries one, so it is an error to fix rather than something stripped silently.
const hasNul = (v: unknown): boolean =>
  typeof v === 'string' ? v.includes('\0') : typeof v === 'object' && v !== null && Object.values(v).some(hasNul)

export function validateSlide(d: EditableSlide): string[] {
  if (hasNul(d)) return ['Remove the hidden control character from this slide.']
  switch (d.type) {
    case 'quiz_mcq':
      return validateMcq(d)
  }
}

export function toStoredSlide(d: EditableSlide): { prompt: string; config: SlideConfig } {
  switch (d.type) {
    case 'quiz_mcq':
      return toStored(d)
  }
}

/**
 * A stored row back into the draft shape the validators take — used by the deck ready-gate,
 * which re-validates every saved slide before a deck can go live.
 *
 * Returns null when `type` and `config` disagree, because nothing in the database enforces
 * that pairing: `config` is jsonb and `type` is free text, so a row written by a hand-run SQL
 * statement or an old build could hold a config that is not an MCQ's (polls, removed
 * 2026-10-05, stored one with no points). Treating that as "invalid slide" keeps it out of a live room instead of
 * crashing mid-game on a missing field.
 */
export function toEditable(s: {
  type: string
  prompt: string
  config: SlideConfig
}): EditableSlide | null {
  // `options` is checked too, not just the discriminating key: the validators below iterate it
  // (`options.length`, `options.some`), so a row missing it would throw out of the ready-gate
  // instead of failing it — and SlideCard renders its "unrecognised slide" fallback off a null.
  if (!Array.isArray(s.config?.options)) return null
  if (s.type === 'quiz_mcq' && 'points' in s.config)
    return { type: 'quiz_mcq', prompt: s.prompt, ...s.config }
  return null
}
