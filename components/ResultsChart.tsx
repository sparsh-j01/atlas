'use client'

import { useEffect, useState } from 'react'
import type { AggregateMcq, SanitizedSlide } from '@/lib/realtime/events'
import { ResultsBars } from '@/components/ResultsBars'

// Picks the result view for a slide. Quiz slides have no `chart` and always get bars; a poll
// gets whatever its editor chose. Everything reads the same `{ counts, total }` aggregate —
// only the drawing differs, which is why one aggregate shape serves both slide types.
export function ResultsChart(props: {
  slide: SanitizedSlide
  aggregate: AggregateMcq | null
  correctId?: string | null
  pickedId?: string | null
}) {
  const { slide, aggregate, correctId = null, pickedId } = props
  if (slide.chart === 'pie' || slide.chart === 'donut') {
    return <ResultsPie slide={slide} aggregate={aggregate} pickedId={pickedId} hole={slide.chart === 'donut'} />
  }
  return <ResultsBars slide={slide} aggregate={aggregate} correctId={correctId} pickedId={pickedId} />
}

// Six fixed hues, one per option slot (MAX_OPTIONS). Assigned by index rather than hashed
// from the option id, so the same option keeps its colour between the live feed and the
// final chart instead of jumping as counts change.
const PALETTE = ['#e0a83a', '#5aa9e6', '#4fbf8b', '#b98be8', '#e8845c', '#7fd1c1']

const SIZE = 200
const OUTER = 92 // leaves a little room inside the viewBox for the stroke's antialiasing

/**
 * Pie/donut over the same aggregate the bars use. Drawn as one circle per segment with
 * `stroke-dasharray`, not as path arcs: the arc maths needs a special case at exactly 100%
 * (start and end points coincide, so the arc collapses and a single-option sweep vanishes),
 * and dash offsets have no such degenerate case.
 */
function ResultsPie({
  slide,
  aggregate,
  pickedId,
  hole,
}: {
  slide: SanitizedSlide
  aggregate: AggregateMcq | null
  pickedId?: string | null
  hole: boolean
}) {
  const total = aggregate?.total ?? 0

  // Same grow-from-nothing reveal as the bars: paint empty, then transition on the next
  // frame, so the distribution lands as an animation rather than a finished chart.
  const [grown, setGrown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // A donut's stroke is a ring; a pie's stroke is thick enough to close the middle entirely.
  const stroke = hole ? OUTER * 0.45 : OUTER
  const r = OUTER - stroke / 2
  const circumference = 2 * Math.PI * r

  // Each wedge starts where the previous ones ended. Summed per option rather than carried
  // in an accumulator: React's compiler rejects reassignment during render, and at ≤6
  // options the repeated sum costs nothing.
  const counts = slide.options.map((o) => aggregate?.counts[o.id] ?? 0)
  const fracs = counts.map((n) => (total > 0 ? n / total : 0))
  const segments = slide.options.map((o, i) => ({
    o,
    n: counts[i],
    frac: fracs[i],
    color: PALETTE[i % PALETTE.length],
    offset: fracs.slice(0, i).reduce((a, b) => a + b, 0),
  }))

  return (
    <div className="flex flex-wrap items-center gap-8">
      <svg
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="h-56 w-56 shrink-0"
        role="img"
        aria-label={
          total === 0
            ? 'No responses yet'
            : segments
                .map((s) => `${s.o.text}: ${s.n} of ${total} (${Math.round(s.frac * 100)}%)`)
                .join('; ')
        }
      >
        {/* Track — also the whole chart while nobody has answered, so an open poll reads as
            an empty dial rather than a blank rectangle. */}
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          className="stroke-overlay"
        />
        {segments.map((s) =>
          s.frac > 0 ? (
            <circle
              key={s.o.id}
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={stroke}
              // Start at 12 o'clock instead of 3 — a chart that begins anywhere else reads
              // as rotated.
              transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
              strokeDasharray={`${(grown ? s.frac : 0) * circumference} ${circumference}`}
              strokeDashoffset={-s.offset * circumference}
              className="transition-[stroke-dasharray] duration-700 ease-out motion-reduce:transition-none"
            />
          ) : null,
        )}
      </svg>

      {/* The legend is the accessible + readable half: percentages are hard to judge by eye
          from a wedge, and a projector at the back of a room needs the number. */}
      <ul className="flex min-w-48 flex-col gap-2">
        {segments.map((s) => (
          <li key={s.o.id} className="flex items-baseline gap-3">
            <span
              aria-hidden
              className="h-3 w-3 shrink-0 translate-y-0.5 rounded-[2px]"
              style={{ background: s.color }}
            />
            <span className="truncate text-xl">
              {s.o.text}
              {s.o.id === pickedId && (
                <span className="ml-2 text-sm text-lamp">your answer</span>
              )}
            </span>
            <span className="ml-auto shrink-0 font-data text-sm tabular-nums text-dim">
              {s.n} / {Math.round(s.frac * 100)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
