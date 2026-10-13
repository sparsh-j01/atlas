import type { LeaderboardEntry } from '@/lib/realtime/events'

// Rows are absolutely positioned and moved by transform, so React never reorders the DOM —
// each row keeps its identity and CSS animates it from its old slot to its new one. That's
// the reorder you want to watch, and it's why the re-rank is coalesced to once per question
// (docs/architecture.md): one settling animation per question instead of a per-answer storm.

// Row height + gap; the container height is derived from it. This is the host console, which
// is the projector — 60px with 24px names was laptop scale on a screen read from the back of
// a room.
//
// 72, not 84, and the number is load-bearing rather than taste: a full top-10 has to fit a
// 1080p projector. 10 × 84 = 840 overflowed the column it had; 10 × 72 = 720 fits.
const ROW = 72

export function Leaderboard({ entries }: { entries: LeaderboardEntry[] }) {
  if (entries.length === 0) return null

  // Sorted defensively so the slots are right even if a payload ever arrives out of order.
  const rows = [...entries].sort((a, b) => a.rank - b.rank)

  return (
    <ol className="relative" style={{ height: rows.length * ROW }} aria-label="Leaderboard">
      {rows.map((e, slot) => {
        const lead = e.rank === 1
        return (
          <li
            key={e.participantId}
            className={`absolute inset-x-0 flex items-center gap-3 rounded-plate border px-3 sm:gap-5 sm:px-6 transition-[transform,background-color,border-color] duration-700 ease-out motion-reduce:transition-none ${
              lead ? 'border-pen/40 bg-raised' : 'border-rule bg-raised'
            }`}
            style={{ transform: `translateY(${slot * ROW}px)`, height: ROW - 8 }}
            data-rank={e.rank}
          >
            {/* Playfair, per docs/design.md §8 — and it does not trip §4's "changing figures
                must not be serif" rule: a rank moves once per question, discretely, not on a
                250ms tick like the countdown. The score beside it stays .tabular. */}
            <span className={`font-display w-8 shrink-0 text-center text-xl sm:w-12 sm:text-3xl ${lead ? 'text-pen' : 'text-dim'}`}>
              {e.rank}
            </span>
            <span className="min-w-0 flex-1 truncate text-xl font-semibold sm:text-4xl">{e.nickname}</span>
            <span className={`tabular shrink-0 text-xl sm:text-4xl ${lead ? 'text-pen' : 'text-ink'}`}>{e.score}</span>
          </li>
        )
      })}
    </ol>
  )
}
