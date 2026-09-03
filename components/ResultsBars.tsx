'use client'

import { useEffect, useState } from 'react'
import type { AggregateMcq, SanitizedSlide } from '@/lib/realtime/events'

// The reveal view: how the room answered, with the correct option called out. Bars grow
// from 0 on mount, so the distribution lands as an animation rather than a static chart.
// Only rendered after the host reveals — the counts would otherwise let the room herd
// toward the popular answer (which is why nothing broadcasts them during the question).
export function ResultsBars({
  slide,
  aggregate,
  correctId,
  pickedId,
}: {
  slide: SanitizedSlide
  aggregate: AggregateMcq | null
  correctId: string | null
  /** This viewer's own answer, marked so they can find themselves in the distribution. */
  pickedId?: string | null
}) {
  const total = aggregate?.total ?? 0

  // A CSS transition animates a CHANGE, so mounting at the final width would just paint the
  // finished chart. Paint at 0 first, then widen on the next frame — that's the reveal.
  // requestAnimationFrame (not a bare setState) so the zero-width paint actually happens.
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // lg: is the room. This only ever renders on the host console, but the host is often on a
  // laptop before the projector is plugged in — so the base tier stays laptop-sized and the
  // room scale arrives with the width.
  return (
    <ul className="flex flex-col gap-3 lg:gap-5">
      {slide.options.map((o) => {
        const n = aggregate?.counts[o.id] ?? 0
        // Share of responses, not of players: a slide nobody answered shows empty bars
        // rather than dividing by zero.
        const pct = total > 0 ? Math.round((n / total) * 100) : 0
        const isCorrect = o.id === correctId
        return (
          <li key={o.id}>
            <div className="mb-1.5 flex items-baseline justify-between gap-3">
              <span
                className={`truncate text-xl lg:text-3xl ${
                  isCorrect ? 'font-semibold text-correct' : ''
                }`}
              >
                {o.text}
                {/* The word, not just the lime. On the projector the right answer was
                    signalled by colour alone, which docs/design.md §10 rules out and which
                    a colour-blind student at the back cannot read. aria-hidden because the
                    bar below already ends its own label with ", correct". */}
                {isCorrect && (
                  <span aria-hidden className="ml-2 text-sm font-normal lg:text-xl">
                    ✓ Correct
                  </span>
                )}
                {o.id === pickedId && (
                  <span className="ml-2 text-sm font-normal text-pen lg:text-xl">your answer</span>
                )}
              </span>
              <span className="shrink-0 tabular text-sm tabular-nums text-dim lg:text-2xl">
                {n} / {pct}%
              </span>
            </div>
            <div className="h-7 overflow-hidden rounded-plate bg-overlay lg:h-12">
              <div
                // ponytail: `width` animates layout, unlike the drain bars which moved to
                // scaleX. Kept here on purpose — this fires once per reveal on at most six
                // rows, and the bar has a 20px radius that scaleX would squash into an
                // ellipse. Revisit only if the reveal ever measures as a jank source.
                className={`h-full rounded-plate transition-[width] duration-700 ease-out motion-reduce:transition-none ${
                  isCorrect ? 'bg-correct' : 'bg-rule-strong'
                }`}
                style={{ width: grown ? `${pct}%` : '0%' }}
                role="img"
                aria-label={`${o.text}: ${n} of ${total} (${pct}%)${isCorrect ? ', correct' : ''}`}
              />
            </div>
          </li>
        )
      })}
    </ul>
  )
}
