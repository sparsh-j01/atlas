'use client'

import { avatarUrl } from '@/lib/avatars'
import { Leaderboard } from '@/components/Leaderboard'
import type { LeaderboardEntry } from '@/lib/realtime/events'

// The closing screen: top three on blocks, everyone else listed below. Ranks come from the
// server (lib/realtime/aggregate.ts) — this only arranges them.
// Podium order is 2nd, 1st, 3rd so first place stands in the middle, and the block heights
// carry the ranking even before you read the numbers.
const PLACE = [
  { rank: 2, h: 'h-28' },
  { rank: 1, h: 'h-44' },
  { rank: 3, h: 'h-20' },
]

export function Podium({
  ranking,
  highlightId,
}: {
  ranking: LeaderboardEntry[]
  highlightId?: string
}) {
  const byRank = new Map(ranking.map((e) => [e.rank, e]))
  const rest = ranking.filter((e) => e.rank > 3)

  return (
    <div className="flex flex-col gap-12">
      <div className="flex items-end justify-center gap-4 sm:gap-6">
        {PLACE.map(({ rank, h }) => {
          const e = byRank.get(rank)
          if (!e) return null // fewer than three players — render the places that exist
          const mine = e.participantId === highlightId
          const first = rank === 1
          return (
            <div key={rank} className="flex w-28 flex-col items-center gap-3 sm:w-40">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl(e.avatarSeed)}
                alt=""
                className={`rounded-full bg-overlay ring-2 ${
                  first ? 'h-16 w-16 ring-lamp sm:h-20 sm:w-20' : 'h-12 w-12 ring-rule sm:h-14 sm:w-14'
                }`}
              />
              <span className="max-w-full truncate text-center font-semibold">
                {e.nickname}
                {mine && <span className="ml-1 text-sm font-normal text-lamp">you</span>}
              </span>
              <span className="font-data tabular-nums text-dim">{e.score}</span>
              <div
                className={`flex w-full items-start justify-center rounded-t-plate pt-3 ${h} ${
                  first ? 'bg-lamp' : 'bg-overlay'
                }`}
              >
                <span
                  className={`font-data text-3xl tabular-nums ${first ? 'text-lamp-ink' : 'text-dim'}`}
                >
                  {rank}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {rest.length > 0 && (
        <section>
          <h3 className="mb-4 text-lg font-semibold text-dim">Everyone else</h3>
          <Leaderboard entries={rest} highlightId={highlightId} compact />
        </section>
      )}
    </div>
  )
}
