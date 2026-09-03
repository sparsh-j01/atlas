'use client'

import { avatarUrl } from '@/lib/avatars'
import type { LeaderboardEntry } from '@/lib/realtime/events'

// Rows are absolutely positioned and moved by transform, so React never reorders the DOM —
// each row keeps its identity and CSS animates it from its old slot to its new one. That's
// the reorder you want to watch, and it's why the re-rank is coalesced to the reveal
// (docs/architecture.md): one settling animation per question instead of a per-answer storm.

// Row height + gap; the container height is derived from it. Non-compact is the host
// console, which is the projector — 60px with 24px names was laptop scale on a screen read
// from the back of a room. Compact (the phone, and the podium's also-rans) is unchanged.
//
// 72, not 84, and the number is load-bearing rather than taste: a full top-10 has to fit the
// standings column of a 1080p projector beside the results. That column gets 1080 − ~130
// header − 80 padding − ~80 control bar − ~31 heading ≈ 760px, and 10 × 84 = 840 overflowed
// it. 10 × 72 = 720 fits. The row still carries a 56px avatar and a 36px name inside 64px.
const ROW = 72
const ROW_COMPACT = 48

export function Leaderboard({
  entries,
  highlightId,
  compact = false,
  showDelta = true,
}: {
  entries: LeaderboardEntry[]
  /** This viewer's own row, lifted out of the crowd on a shared screen. */
  highlightId?: string
  /** Phone-sized type instead of projector-sized. */
  compact?: boolean
  /** Rank movement since the last question. Off on final standings, where there is no
   *  next question for "+2" to be measured against. */
  showDelta?: boolean
}) {
  if (entries.length === 0) return null
  const row = compact ? ROW_COMPACT : ROW

  // Slot is the position in THIS list, not the raw rank — so a sliced list (the podium's
  // "everyone else", starting at rank 4) still stacks from the top. Sorted defensively so
  // the slots are right even if a payload ever arrives out of order.
  const rows = [...entries].sort((a, b) => a.rank - b.rank)

  return (
    <ol className="relative" style={{ height: rows.length * row }} aria-label="Leaderboard">
      {rows.map((e, slot) => {
        const mine = e.participantId === highlightId
        const lead = e.rank === 1
        return (
          <li
            key={e.participantId}
            className={`absolute inset-x-0 flex items-center rounded-plate border ${
              compact ? 'gap-3 px-4' : 'gap-5 px-6'
            } transition-[transform,background-color,border-color] duration-700 ease-out motion-reduce:transition-none ${
              mine
                ? 'border-pen bg-pen/10'
                : lead
                  ? 'border-pen/40 bg-raised'
                  : 'border-rule bg-raised'
            }`}
            style={{ transform: `translateY(${slot * row}px)`, height: row - 8 }}
            data-rank={e.rank}
          >
            {/* Playfair, per docs/design.md §8 — and it does not trip §4's "changing figures
                must not be serif" rule: a rank moves once per reveal, discretely, not on a
                250ms tick like the countdown and the live tally. The score beside it is the
                one that keeps counting, so that one stays .tabular. */}
            <span
              className={`font-display shrink-0 text-center ${
                compact ? 'w-7 text-sm' : 'w-12 text-3xl'
              } ${lead ? 'text-pen' : 'text-dim'}`}
            >
              {e.rank}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={avatarUrl(e.avatarSeed)}
              alt=""
              className={`shrink-0 rounded-full bg-overlay ${compact ? 'h-7 w-7' : 'h-14 w-14'}`}
            />
            <span className={`flex-1 truncate font-semibold ${compact ? 'text-base' : 'text-4xl'}`}>
              {e.nickname}
              {mine && (
                <span className={`ml-2 font-normal text-pen ${compact ? 'text-sm' : 'text-xl'}`}>
                  you
                </span>
              )}
            </span>
            {showDelta && <Delta delta={e.delta} compact={compact} />}
            <span
              className={`tabular ${compact ? 'text-base' : 'text-4xl'} ${
                lead ? 'text-pen' : 'text-ink'
              }`}
            >
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
function Delta({ delta, compact }: { delta: number; compact: boolean }) {
  const w = compact ? 'w-9' : 'w-14'
  if (delta === 0) return <span className={w} aria-hidden />
  const up = delta > 0
  return (
    <span
      className={`${w} text-right tabular tabular-nums ${compact ? 'text-sm' : 'text-xl'} ${
        up ? 'text-correct' : 'text-dim'
      }`}
      title={`${up ? 'Up' : 'Down'} ${Math.abs(delta)} since the last question`}
    >
      {up ? '+' : '-'}
      {Math.abs(delta)}
    </span>
  )
}
