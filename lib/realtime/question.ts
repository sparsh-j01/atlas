import 'server-only'
// The single hardcoded MCQ for the M1 realtime spike. Marked `server-only` so the
// answer key (`is_correct`) is physically un-importable from a client bundle — clients
// only ever see the sanitized slide (from the broadcast/`/state` payload) until reveal.
// Real decks/slides land in M2/M3; this is a stand-in to prove the live loop.

export const SPIKE_SLIDE_ID = 'm1-spike-q1'

interface McqOption {
  id: string
  text: string
  is_correct: boolean
}

export const SPIKE_QUESTION = {
  id: SPIKE_SLIDE_ID,
  type: 'quiz_mcq' as const,
  prompt: 'Which data structure gives O(1) average-case lookup by key?',
  options: [
    { id: 'a', text: 'Array', is_correct: false },
    { id: 'b', text: 'Hash map', is_correct: true },
    { id: 'c', text: 'Linked list', is_correct: false },
    { id: 'd', text: 'Balanced BST', is_correct: false },
  ] as McqOption[],
  timeLimitMs: 20000,
  points: 1000,
}

/** The slide as clients may see it BEFORE reveal — the answer key is stripped. */
export function sanitizeSlide() {
  return {
    id: SPIKE_QUESTION.id,
    type: SPIKE_QUESTION.type,
    prompt: SPIKE_QUESTION.prompt,
    options: SPIKE_QUESTION.options.map(({ id, text }) => ({ id, text })),
    points: SPIKE_QUESTION.points,
  }
}

export function correctOptionId(): string {
  const correct = SPIKE_QUESTION.options.find((o) => o.is_correct)
  if (!correct) throw new Error('spike question has no correct option')
  return correct.id
}

export function isValidOptionId(optionId: unknown): optionId is string {
  return typeof optionId === 'string' && SPIKE_QUESTION.options.some((o) => o.id === optionId)
}
