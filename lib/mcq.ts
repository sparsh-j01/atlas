// Pure, client+server safe (no `server-only`, no DB imports). The one source of truth for
// the MCQ slide shape + validation — imported by the schema (config `$type`), the server
// actions (validate before persist), and the client editor (live inline errors).

// Stored option shape mirrors lib/realtime/question.ts (`is_correct`) so M3 can feed a
// saved slide into a live session with no translation.
export type McqOption = { id: string; text: string; is_correct: boolean }
export type McqConfig = { options: McqOption[]; timeLimitMs: number; points: number }
// Widen to a union (poll | word_cloud) in M5. Single type for now — no speculative variants.
export type SlideConfig = McqConfig

// Editable draft in the browser is the same shape as stored (option already has an id).
export type EditableMcq = { prompt: string; options: McqOption[]; timeLimitMs: number; points: number }

export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6
export const MCQ_DEFAULTS = { timeLimitMs: 20_000, points: 1_000 }
const TIME_MIN_MS = 5_000
const TIME_MAX_MS = 300_000
const POINTS_MAX = 5_000

function uuid(): string {
  return crypto.randomUUID()
}

export function newOption(is_correct = false): McqOption {
  return { id: uuid(), text: '', is_correct }
}

/** A fresh slide: two blank options, the first pre-marked correct (so "exactly one
 *  correct" holds as soon as the texts are filled in). */
export function blankMcq(): EditableMcq {
  return { prompt: '', options: [newOption(true), newOption(false)], ...MCQ_DEFAULTS }
}

/** Human-readable errors, empty when valid. Same rules the plan names: exactly one
 *  correct option, 2–6 options, no empty/duplicate options, plus sane time/points. */
export function validateMcq(m: EditableMcq): string[] {
  const errors: string[] = []

  if (!m.prompt.trim()) errors.push('Question prompt is required.')

  const n = m.options.length
  if (n < MIN_OPTIONS) errors.push(`Add at least ${MIN_OPTIONS} options.`)
  if (n > MAX_OPTIONS) errors.push(`No more than ${MAX_OPTIONS} options.`)

  if (m.options.some((o) => !o.text.trim())) errors.push('Every option needs text.')

  const seen = new Set<string>()
  let dup = false
  for (const o of m.options) {
    const key = o.text.trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) dup = true
    seen.add(key)
  }
  if (dup) errors.push('Options must be unique.')

  const correct = m.options.filter((o) => o.is_correct).length
  if (correct !== 1) errors.push('Mark exactly one option correct.')

  if (!(m.timeLimitMs >= TIME_MIN_MS && m.timeLimitMs <= TIME_MAX_MS))
    errors.push(`Time limit must be ${TIME_MIN_MS / 1000}–${TIME_MAX_MS / 1000} seconds.`)
  if (!(m.points >= 0 && m.points <= POINTS_MAX)) errors.push(`Points must be 0–${POINTS_MAX}.`)

  return errors
}

/** Trim to the persisted shape. Caller must validate first. */
export function toStored(m: EditableMcq): { prompt: string; config: McqConfig } {
  return {
    prompt: m.prompt.trim(),
    config: {
      options: m.options.map((o) => ({ id: o.id, text: o.text.trim(), is_correct: o.is_correct })),
      timeLimitMs: m.timeLimitMs,
      points: m.points,
    },
  }
}
