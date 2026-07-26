'use client'

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
                style={{ width: `${pct}%` }}
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
