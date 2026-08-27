// Deck-level validation for generated content: what survives, in what order, and whether
// a run produced enough to ship. Per-slide shape rules live in lib/slides (the SAME
// validators the hand-built editor uses — a generated slide is never held to a lower bar);
// this module adds only the cross-deck rules generation needs.
//
// Pure: no provider, no DB — fully unit-testable.

import { validateSlide, type EditableSlide } from '../slides'
import { GEN_LIMITS } from './blueprint'

/** Bounded regeneration: each slide gets one initial attempt + one retry before its
 *  blueprint entry is dropped (plan: "reject + regenerate bad slides"). */
export const GEN_MAX_ATTEMPTS = 2

/** Prompts compare case-insensitively, whitespace-collapsed, ignoring trailing
 *  punctuation — "What is X?" vs "what is x" counts as one question asked twice. */
export function normalizePrompt(p: string): string {
  return p
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?!.]+$/, '')
}

export type ProducedSlide = { subtopic: string; slide: EditableSlide | null }

export type FinalizedSlides =
  | { ok: true; slides: EditableSlide[]; dropped: string[] }
  | { ok: false; errors: string[] }

/**
 * Apply the cross-deck rules to everything phase 2 produced:
 *   1. drop entries that failed structurally or fail validateSlide,
 *   2. drop later duplicates of an already-accepted prompt (first wins),
 *   3. require enough survivors that the deck is still worth showing.
 *
 * The floor is `max(minSlides, half the requested count)`: dropping one bad slide out of
 * ten is fine (the host reviews everything anyway), but if most of the run failed the
 * right answer is a clear error, not a silently thin deck.
 */
export function finalizeSlides(
  produced: ProducedSlide[],
  requestedCount: number,
): FinalizedSlides {
  const dropped: string[] = []
  const accepted: EditableSlide[] = []
  const seenPrompts = new Set<string>()

  for (const [i, p] of produced.entries()) {
    const label = `slide ${i + 1} ("${p.subtopic}")`
    if (!p.slide) {
      dropped.push(`${label}: generation produced an unusable slide`)
      continue
    }
    const errs = validateSlide(p.slide)
    if (errs.length) {
      dropped.push(`${label}: ${errs[0]}`)
      continue
    }
    const key = normalizePrompt(p.slide.prompt)
    if (seenPrompts.has(key)) {
      dropped.push(`${label}: duplicate question`)
      continue
    }
    seenPrompts.add(key)
    accepted.push(p.slide)
  }

  const floor = Math.max(GEN_LIMITS.minSlides, Math.ceil(requestedCount / 2))
  if (accepted.length < floor)
    return {
      ok: false,
      errors: [
        ...dropped,
        `Only ${accepted.length} of ${requestedCount} requested slides survived validation — need at least ${floor}.`,
      ],
    }
  return { ok: true, slides: accepted, dropped }
}
