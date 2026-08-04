// Pure, client+server safe (no `server-only`, no DB imports) — the poll counterpart to
// lib/mcq.ts, and the same single source of truth for its shape + validation.
//
// A poll is an MCQ with the two scoring concepts removed: no `is_correct` on any option and
// no `points`. That is the whole difference, and it's why so little of the session engine
// had to change — the option list, the answer window, and the tally are identical, so a poll
// answer travels the same `{ optionId }` path a quiz answer does.
import { validateOptionSlide } from './mcq'

// No `is_correct`: there is nothing to be right about, so the field doesn't exist rather
// than existing as `false` everywhere. That's what lets correctOptionId() return null for a
// poll without a slide-type check (see lib/mcq.ts).
export type PollOption = { id: string; text: string }

export const CHART_KINDS = ['bar', 'pie', 'donut'] as const
export type ChartKind = (typeof CHART_KINDS)[number]

export type PollConfig = {
  options: PollOption[]
  timeLimitMs: number
  chart: ChartKind
}

// Editable draft in the browser is the same shape as stored (option already has an id).
export type EditablePoll = {
  prompt: string
  options: PollOption[]
  timeLimitMs: number
  chart: ChartKind
}

// Longer default window than a quiz question: a poll has no speed bonus, so there's no
// reason to rush the room, and results build live while it's open.
export const POLL_DEFAULTS = { timeLimitMs: 30_000, chart: 'bar' as ChartKind }

export function newPollOption(): PollOption {
  return { id: crypto.randomUUID(), text: '' }
}

/** A fresh poll: two blank options. Valid-shaped as soon as the texts are filled in. */
export function blankPoll(): EditablePoll {
  return { prompt: '', options: [newPollOption(), newPollOption()], ...POLL_DEFAULTS }
}

/** Human-readable errors, empty when valid. The shared option rules and nothing else —
 *  "exactly one correct" and the points range are the two MCQ checks that don't apply. */
export function validatePoll(p: EditablePoll): string[] {
  const errors = validateOptionSlide(p)
  // The chart drives which component renders it; an unknown value would fall through to a
  // blank result view mid-session, so it's checked here rather than defaulted at render.
  if (!(CHART_KINDS as readonly string[]).includes(p.chart)) errors.push('Pick a chart type.')
  return errors
}

/** Trim to the persisted shape. Caller must validate first. */
export function toStoredPoll(p: EditablePoll): { prompt: string; config: PollConfig } {
  return {
    prompt: p.prompt.trim(),
    config: {
      options: p.options.map((o) => ({ id: o.id, text: o.text.trim() })),
      timeLimitMs: p.timeLimitMs,
      chart: p.chart,
    },
  }
}
