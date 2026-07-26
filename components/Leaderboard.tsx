'use client'

import { avatarUrl } from '@/lib/avatars'
import type { LeaderboardEntry } from '@/lib/realtime/events'

// Rows are absolutely positioned and moved by transform, so React never reorders the DOM —
// each row keeps its identity and CSS animates it from its old slot to its new one. That's
// the reorder you want to watch, and it's why the re-rank is coalesced to the reveal
// (docs/architecture.md): one settling animation per question instead of a per-answer storm.
const ROW = 56 // px, row height + gap; the container height is derived from it

export function Leaderboard({
  entries,
  highlightId,
  compact = false,
}: {
  entries: LeaderboardEntry[]
  /** This viewer's own row, lifted out of the crowd on a shared screen. */
  highlightId?: string
  /** Phone-sized type instead of projector-sized. */
  compact?: boolean
}) {
  if (entries.length === 0) return null

  // Slot is the position in THIS list, not the raw rank — so a sliced list (the podium's
  // "everyone else", starting at rank 4) still stacks from the top. Sorted defensively so
  // the slots are right even if a payload ever arrives out of order.
  const rows = [...entries].sort((a, b) => a.rank - b.rank)

  return (
    <ol className="relative" style={{ height: rows.length * ROW }} aria-label="Leaderboard">
      {rows.map((e, slot) => {
        const mine = e.participantId === highlightId
        return (
          <li
            key={e.participantId}
            className={`absolute inset-x-0 flex items-center gap-3 rounded-xl border px-4 transition-[transform,background-color,border-color] duration-700 ease-out motion-reduce:transition-none ${
              mine
                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950'
                : 'border-neutral-200 bg-white dark:border-neutral-800 dark:bg-neutral-900'
            }`}
            style={{ transform: `translateY(${slot * ROW}px)`, height: ROW - 8 }}
            data-rank={e.rank}
          >
            <span
              className={`w-8 shrink-0 text-center font-semibold tabular-nums ${
                compact ? 'text-base' : 'text-2xl'
              }`}
            >
              {e.rank}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl(e.avatarSeed)}
              alt=""
              className={`shrink-0 rounded-full bg-neutral-100 ${compact ? 'h-8 w-8' : 'h-10 w-10'}`}
            />
            <span className={`flex-1 truncate font-medium ${compact ? 'text-base' : 'text-2xl'}`}>
              {e.nickname}
              {mine && <span className="ml-2 text-sm font-normal text-indigo-500">you</span>}
            </span>
            <Delta delta={e.delta} />
            <span className={`tabular-nums ${compact ? 'text-base' : 'text-2xl font-semibold'}`}>
              {e.score}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/** Rank movement since the last broadcast top-N. 0 means new or unchanged, so it stays blank
 *  rather than claiming "no movement" for someone who just appeared. */
function Delta({ delta }: { delta: number }) {
  if (delta === 0) return <span className="w-10" aria-hidden />
  const up = delta > 0
  return (
    <span
      className={`w-10 text-right text-sm tabular-nums ${up ? 'text-green-600' : 'text-neutral-400'}`}
      title={`${up ? 'Up' : 'Down'} ${Math.abs(delta)} since the last question`}
    >
      {up ? '▲' : '▼'}
      {Math.abs(delta)}
    </span>
  )
}
