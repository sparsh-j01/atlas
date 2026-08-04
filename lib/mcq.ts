// Pure, client+server safe (no `server-only`, no DB imports). The one source of truth for
// the MCQ slide shape + validation — imported by the schema (config `$type`), the server
// actions (validate before persist), and the client editor (live inline errors).

// Stored option shape mirrors lib/realtime/question.ts (`is_correct`) so M3 can feed a
// saved slide into a live session with no translation.
export type McqOption = { id: string; text: string; is_correct: boolean }
// `explanation` is optional teaching copy shown to the room AFTER the reveal — never
// before, since it gives the answer away. M6's emit_slide tool emits one per generated
// question, so the field lands here now rather than needing a schema change later.
export type McqConfig = {
  options: McqOption[]
  timeLimitMs: number
  points: number
  explanation?: string
}
// The slide-type union lives in lib/slides.ts (M5 added poll). It imports this module, not
// the other way round — everything here stays MCQ-specific or structurally typed, so there
// is no cycle.

// Editable draft in the browser is the same shape as stored (option already has an id).
export type EditableMcq = {
  prompt: string
  options: McqOption[]
  timeLimitMs: number
  points: number
  explanation?: string
}

export const MIN_OPTIONS = 2
export const MAX_OPTIONS = 6
export const MCQ_DEFAULTS = { timeLimitMs: 20_000, points: 1_000 }
export const EXPLANATION_MAX = 500
export const TIME_MIN_MS = 5_000
export const TIME_MAX_MS = 300_000
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

/**
 * The rules every option-based slide shares: a prompt, 2–6 options with text and no
 * duplicates, and a sane answer window. MCQ and poll both start here and append their own,
 * so a fix to (say) duplicate detection lands on both types instead of only the one someone
 * remembered to edit (failure-patterns #4).
 */
export function validateOptionSlide(s: {
  prompt: string
  options: { text: string }[]
  timeLimitMs: number
}): string[] {
  const errors: string[] = []

  if (!s.prompt.trim()) errors.push('Question prompt is required.')

  const n = s.options.length
  if (n < MIN_OPTIONS) errors.push(`Add at least ${MIN_OPTIONS} options.`)
  if (n > MAX_OPTIONS) errors.push(`No more than ${MAX_OPTIONS} options.`)

  if (s.options.some((o) => !o.text.trim())) errors.push('Every option needs text.')

  const seen = new Set<string>()
  let dup = false
  for (const o of s.options) {
    const key = o.text.trim().toLowerCase()
    if (!key) continue
    if (seen.has(key)) dup = true
    seen.add(key)
  }
  if (dup) errors.push('Options must be unique.')

  if (!(s.timeLimitMs >= TIME_MIN_MS && s.timeLimitMs <= TIME_MAX_MS))
    errors.push(`Time limit must be ${TIME_MIN_MS / 1000}–${TIME_MAX_MS / 1000} seconds.`)

  return errors
}

/** Human-readable errors, empty when valid. The shared option rules, plus the two that
 *  only a scored question has: exactly one correct option, and sane points. */
export function validateMcq(m: EditableMcq): string[] {
  const errors = validateOptionSlide(m)

  const correct = m.options.filter((o) => o.is_correct).length
  if (correct !== 1) errors.push('Mark exactly one option correct.')

  if (!(m.points >= 0 && m.points <= POINTS_MAX)) errors.push(`Points must be 0–${POINTS_MAX}.`)

  // Optional, but bounded: it goes on a projector at the reveal, and an unbounded blob
  // would push the results off screen.
  if ((m.explanation?.trim().length ?? 0) > EXPLANATION_MAX)
    errors.push(`Explanation must be ${EXPLANATION_MAX} characters or fewer.`)

  return errors
}

// --- Live-session views of a saved config (M3) ---
// Pure so they're unit-tested here; the DB-backed slide loader (lib/realtime/live-slide.ts)
// is the server-only wrapper around them.
//
// Typed STRUCTURALLY rather than against McqConfig, so M5's poll config flows through the
// same three functions with no per-type branching at the call sites — a poll's options are
// an MCQ's minus `is_correct`, which is precisely what each of these already tolerates.
// It also keeps this module free of any import from lib/slides.ts (which imports this one).

/** Options as clients may see them — the answer key is stripped. This is the anti-cheat
 *  boundary: everything a participant receives before reveal comes through here. */
export function sanitizeOptions(c: { options: { id: string; text: string }[] }): {
  id: string
  text: string
}[] {
  return c.options.map(({ id, text }) => ({ id, text }))
}

/** null if nothing is marked correct — which is every poll slide (no option carries
 *  `is_correct` at all), and unreachable for a saved MCQ (validateMcq enforces exactly one).
 *  Callers treat null as "nothing to disclose" rather than throwing mid-game, so the reveal
 *  and /state paths need no slide-type check to stay correct on an unscored slide. */
export function correctOptionId(c: { options: { id: string; is_correct?: boolean }[] }): string | null {
  return c.options.find((o) => o.is_correct)?.id ?? null
}

/** Whether an untrusted value names one of this slide's options. */
export function isValidOptionId(c: { options: { id: string }[] }, v: unknown): v is string {
  return typeof v === 'string' && c.options.some((o) => o.id === v)
}

/** Trim to the persisted shape. Caller must validate first. */
export function toStored(m: EditableMcq): { prompt: string; config: McqConfig } {
  const explanation = m.explanation?.trim()
  return {
    prompt: m.prompt.trim(),
    config: {
      options: m.options.map((o) => ({ id: o.id, text: o.text.trim(), is_correct: o.is_correct })),
      timeLimitMs: m.timeLimitMs,
      points: m.points,
      // Omitted entirely when blank, so an empty string never reaches the reveal payload
      // and renders as an empty box on the projector.
      ...(explanation ? { explanation } : {}),
    },
  }
}
