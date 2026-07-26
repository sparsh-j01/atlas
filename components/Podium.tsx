'use client'

import { avatarUrl } from '@/lib/avatars'
import { Leaderboard } from '@/components/Leaderboard'
import type { LeaderboardEntry } from '@/lib/realtime/events'

// The closing screen: top three on blocks, everyone else listed below. Ranks come from the
// server (lib/realtime/aggregate.ts) — this only arranges them.
// Podium order is 2nd, 1st, 3rd so first place stands in the middle, and the block heights
// carry the ranking even before you read the numbers.
const PLACE = [
  { rank: 2, h: 'h-24', medal: '🥈' },
  { rank: 1, h: 'h-36', medal: '🥇' },
  { rank: 3, h: 'h-16', medal: '🥉' },
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
    <div className="flex flex-col gap-10">
      <div className="flex items-end justify-center gap-4 sm:gap-8">
        {PLACE.map(({ rank, h, medal }) => {
          const e = byRank.get(rank)
          if (!e) return null // fewer than three players — render the places that exist
          const mine = e.participantId === highlightId
          return (
            <div key={rank} className="flex w-28 flex-col items-center gap-2 sm:w-36">
              <span className="text-3xl" aria-hidden>
                {medal}
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl(e.avatarSeed)}
                alt=""
                className="h-14 w-14 rounded-full bg-neutral-100 sm:h-16 sm:w-16"
              />
              <span className="max-w-full truncate text-center font-medium">
                {e.nickname}
                {mine && <span className="ml-1 text-sm text-indigo-500">you</span>}
              </span>
              <span className="tabular-nums text-neutral-500">{e.score}</span>
              <div
                className={`flex w-full items-start justify-center rounded-t-xl pt-2 ${h} ${
                  mine ? 'bg-indigo-500' : 'bg-neutral-200 dark:bg-neutral-700'
                }`}
              >
                <span
                  className={`text-2xl font-bold ${mine ? 'text-white' : 'text-neutral-500 dark:text-neutral-300'}`}
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
          <h3 className="mb-3 text-lg font-medium text-neutral-500">Everyone else</h3>
          <Leaderboard entries={rest} highlightId={highlightId} compact />
        </section>
      )}
    </div>
  )
}
