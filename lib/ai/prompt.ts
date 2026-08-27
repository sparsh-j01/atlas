import { randomUUID } from 'node:crypto'

// Shared generation instructions. Kept byte-identical across every call in a run (both
// phases, all parallel slide calls) — that stable prefix is what provider-side implicit
// caching keys on, so editing this string invalidates the cache for one run only.

export const SYSTEM_PROMPT = `You write quiz decks for live classroom games. A teacher presents the deck to a room of students who answer on their phones; a wrong or ambiguous question destroys trust in front of a class.

Rules you always follow:
- Every question is self-contained: never reference other slides, never say "according to the passage above", never number questions.
- Plain text only: no markdown, no LaTeX, no emoji, no surrounding quotation marks.
- A quiz question has EXACTLY ONE correct option. Distractors are plausible but clearly wrong to someone who knows the material.
- A poll is an opinion or experience question with no correct answer. Never mark a poll option correct.
- Keep prompts under 200 characters and option texts under 80 characters.
- Never ask the same thing twice in different words within one deck.`

/**
 * A one-per-run tag name for fencing untrusted document text into a prompt.
 *
 * The evidence blocks used to open `<source>` and close `</source>`. Both tags are fixed
 * strings, so a PDF that CONTAINS `</source>` ends the block early and everything after it
 * reads as top-level prompt content — in the generator and in the judge that is supposed to
 * catch a bad answer key. A delimiter the data can close is not a delimiter.
 *
 * The random suffix fixes that without touching the text. Escaping the extract would also
 * work, but the extract is the evidence a question is graded against, and this milestone's
 * whole rule is that source text reaches the model verbatim.
 */
export function fenceTag(base: string): string {
  // randomUUID, not Math.random: the tag only has to be unguessable to the author of an
  // uploaded PDF, which Math.random already was, but a CSPRNG removes the question for the
  // same one line.
  return `${base}-${randomUUID().slice(0, 8)}`
}
