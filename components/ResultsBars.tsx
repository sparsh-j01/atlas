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

  return (
    <ul className="flex flex-col gap-3">
      {slide.options.map((o) => {
        const n = aggregate?.counts[o.id] ?? 0
        // Share of responses, not of players: a slide nobody answered shows empty bars
        // rather than dividing by zero.
        const pct = total > 0 ? Math.round((n / total) * 100) : 0
        const isCorrect = o.id === correctId
        return (
          <li key={o.id}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className={`truncate text-xl ${isCorrect ? 'font-semibold' : ''}`}>
                {isCorrect && <span className="mr-2 text-green-600">✓</span>}
                {o.text}
                {o.id === pickedId && (
                  <span className="ml-2 text-sm font-normal text-indigo-500">your answer</span>
                )}
              </span>
              <span className="shrink-0 tabular-nums text-neutral-500">
                {n} · {pct}%
              </span>
            </div>
            <div className="h-8 overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800">
              <div
                className={`h-full rounded-lg transition-[width] duration-700 ease-out motion-reduce:transition-none ${
                  isCorrect ? 'bg-green-500' : 'bg-neutral-300 dark:bg-neutral-600'
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
