// Phase 2 of generation: one slide's content. One call per blueprint entry, run in
// parallel by the orchestrating route — wall-clock is the slowest single call, not the
// sum (the plan's reason for splitting generation in two).
//
// Pure module like blueprint.ts: the tool spec + prompt builder + converter are
// unit-testable without any provider or DB.

import {
  EXPLANATION_MAX,
  MCQ_DEFAULTS,
  TIME_MAX_MS,
  TIME_MIN_MS,
} from '../mcq'
import { CHART_KINDS, POLL_DEFAULTS } from '../poll'
import type { EditableSlide, SlideType } from '../slides'
import type { ToolSpec } from './generate'
import type { Difficulty } from './blueprint'

// --- Tool spec ---

export const SLIDE_TOOL: ToolSpec = {
  name: 'emit_slide',
  description:
    'Emit ONE slide for a live classroom game. Quiz questions need exactly one option' +
    ' marked correct; polls are opinion questions where no option may be marked correct.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The question or poll prompt.' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string' },
            // Polls omit this entirely; quizzes set it on EXACTLY ONE option.
            is_correct: { type: 'boolean' },
          },
          required: ['text'],
        },
      },
      explanation: {
        type: 'string',
        description: 'Quiz only: one sentence on why the answer is right, shown at reveal.',
      },
      time_limit_ms: { type: 'integer', description: 'Answer window. Default 20000 (quiz) / 30000 (poll).' },
      points: { type: 'integer', description: 'Quiz only. Default 1000.' },
      chart: { type: 'string', enum: [...CHART_KINDS], description: 'Poll only. Default bar.' },
    },
    required: ['prompt', 'options'],
  },
}

// --- Prompt assembly ---

export function buildSlideMessages(
  ctx: { topic: string; difficulty: Difficulty },
  entry: { type: SlideType; subtopic: string },
): { role: 'user'; content: string }[] {
  return [
    {
      role: 'user',
      content:
        `The deck's topic: ${JSON.stringify(ctx.topic)}.\n` +
        `Difficulty for quiz questions: ${ctx.difficulty}.\n\n` +
        `Now write ONE slide.\n` +
        `Type: ${entry.type}\n` +
        `Subtopic it must test: ${JSON.stringify(entry.subtopic)}`,
    },
  ]
}

// --- Converter: model output → editor draft ---
//
// Structural conversion only: assign option ids server-side (never trust model-supplied
// ids), coerce presentation knobs to defaults when missing or out of range, and return
// null for anything structurally unusable. SEMANTIC checks (exactly-one-correct, no
// duplicate options, sane prompt) are NOT done here — the converted draft goes through
// the same validateSlide() the hand-built editor uses, so a generated slide can never be
// held to a lower bar than a typed one.

const PROMPT_MAX = 500
const OPTION_TEXT_MAX = 200

function isIntInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max
}

/** Raw tool arguments → an editor draft, or null when structurally unusable (caller
 *  regenerates once, then drops the entry). */
export function generatedToEditable(raw: unknown, want: { type: SlideType }): EditableSlide | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const prompt = typeof r.prompt === 'string' ? r.prompt.trim() : ''
  if (!prompt || prompt.length > PROMPT_MAX) return null

  if (!Array.isArray(r.options)) return null
  const parsedOptions: { text: string; is_correct: boolean }[] = []
  for (const o of r.options) {
    if (typeof o !== 'object' || o === null) return null
    const text = typeof o.text === 'string' ? o.text.trim() : ''
    if (!text || text.length > OPTION_TEXT_MAX) return null
    parsedOptions.push({ text, is_correct: o.is_correct === true })
  }
  if (parsedOptions.length < 2 || parsedOptions.length > 6) return null

  const timeLimitMs = isIntInRange(r.time_limit_ms, TIME_MIN_MS, TIME_MAX_MS)
    ? r.time_limit_ms
    : undefined

  if (want.type === 'poll') {
    return {
      type: 'poll',
      prompt,
      options: parsedOptions.map(({ text }) => ({ id: crypto.randomUUID(), text })),
      chart: (CHART_KINDS as readonly string[]).includes(r.chart as string)
        ? (r.chart as (typeof CHART_KINDS)[number])
        : POLL_DEFAULTS.chart,
      timeLimitMs: timeLimitMs ?? POLL_DEFAULTS.timeLimitMs,
    }
  }

  const explanationRaw = typeof r.explanation === 'string' ? r.explanation.trim() : ''
  return {
    type: 'quiz_mcq',
    prompt,
    options: parsedOptions.map((o) => ({ id: crypto.randomUUID(), ...o })),
    // Optional teaching copy: dropped (not truncated) when over budget — a cut-off
    // sentence reads worse than no sentence on the projector at reveal.
    ...(explanationRaw && explanationRaw.length <= EXPLANATION_MAX ? { explanation: explanationRaw } : {}),
    points: isIntInRange(r.points, 0, 5000) ? r.points : MCQ_DEFAULTS.points,
    timeLimitMs: timeLimitMs ?? MCQ_DEFAULTS.timeLimitMs,
  }
}
