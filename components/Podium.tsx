'use client'

import { avatarUrl } from '@/lib/avatars'
import { Leaderboard } from '@/components/Leaderboard'
import type { LeaderboardEntry } from '@/lib/realtime/events'

// The closing screen: top three on blocks, everyone else listed below. Ranks come from the
// server (lib/realtime/aggregate.ts) — this only arranges them.
// Podium order is 2nd, 1st, 3rd so first place stands in the middle, and the block heights
// carry the ranking even before you read the numbers.
//
// Three size tiers, not two. This renders on a phone (play page) and on a projector (host
// console) from the same markup, so the lg: step is the room: below it the type is sized for
// a hand, above it for the back of a hall.
const PLACE = [
  { rank: 2, h: 'h-28 lg:h-44' },
  { rank: 1, h: 'h-44 lg:h-72' },
  { rank: 3, h: 'h-20 lg:h-32' },
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
    // Side by side once it fits, for the same reason as the reveal: stacked, the closing
    // screen measured 1416px against a 1080p projector and ranks 9–12 never appeared. The
    // phone renders the same markup and never reaches the breakpoint, so it keeps the stack.
    //
    // 1380px, not `xl` (1280). The side-by-side row cannot shrink — three lg:w-56 blocks
    // (3 × 224) plus two sm:gap-6 (2 × 24) is a hard 720px, plus gap-16 (64) plus the
    // shrink-0 30rem column (480) is 1264px of content. The host console's own px-10 takes
    // 80, and a scrollbar can take another ~17, so anything under ~1361px viewport ran the
    // standings column off the right edge — right through 1280×800 and 1366×768, two of the
    // commonest laptop widths. Recompute this number if any of those widths change.
    <div className="flex flex-col gap-12 min-[1380px]:flex-row min-[1380px]:items-start min-[1380px]:justify-center min-[1380px]:gap-16">
      <div className="flex items-end justify-center gap-4 sm:gap-6">
        {PLACE.map(({ rank, h }) => {
          const e = byRank.get(rank)
          if (!e) return null // fewer than three players — render the places that exist
          const mine = e.participantId === highlightId
          const first = rank === 1
          // Counts up from third place so the winner's bar lands last.
          const barDelay = (3 - rank) * 90
          const riderDelay = barDelay + 60
          return (
            <div key={rank} className="flex w-28 flex-col items-center gap-3 sm:w-40 lg:w-56 lg:gap-4">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={avatarUrl(e.avatarSeed)}
                alt=""
                style={{ animationDelay: `${riderDelay}ms` }}
                className={`anim-fade-up rounded-full bg-overlay ring-2 ${
                  first
                    ? 'h-16 w-16 ring-pen sm:h-20 sm:w-20 lg:h-28 lg:w-28'
                    : 'h-12 w-12 ring-rule sm:h-14 sm:w-14 lg:h-20 lg:w-20'
                }`}
              />
              {/* Wraps rather than truncating. Nicknames run to 24 characters (the join
                  route's cap) and a 23-character one was being cut to "Maximilian Feath…" on
                  the winner's own block — the one name in the room that has earned being
                  read in full. `break-words` so a single long token still cannot overflow. */}
              <span
                style={{ animationDelay: `${riderDelay}ms` }}
                className={`anim-fade-up max-w-full break-words text-center font-semibold ${
                  first ? 'lg:text-3xl' : 'lg:text-2xl'
                }`}
              >
                {e.nickname}
                {/* whitespace-nowrap because the `break-words` above applies to this span
                    too, and on a phone the blocks are w-28 (112px, and narrower still once
                    three of them plus gaps have to fit 360px). It was breaking the marker
                    itself: "Ramaswamy y / ou". Three letters, and they are the only thing
                    telling a player which block is theirs. */}
                {mine && (
                  <span className="ml-1 whitespace-nowrap text-sm font-normal text-pen lg:text-lg">
                    you
                  </span>
                )}
              </span>
              {/* Playfair and --ink, per docs/design.md §4: a podium score is a figure at
                  rest, and this is the game's last frame. It was the smallest, dimmest text
                  on screen sitting under a 48px rank numeral. */}
              <span
                style={{ animationDelay: `${riderDelay}ms` }}
                className={`font-display anim-fade-up text-xl ${
                  first ? 'lg:text-4xl' : 'lg:text-3xl'
                }`}
              >
                {e.score}
              </span>
              <div
                style={{ animationDelay: `${barDelay}ms` }}
                className={`anim-rise flex w-full items-start justify-center rounded-t-plate pt-3 lg:pt-5 ${h} ${
                  // The 2nd/3rd fill is --overlay, which is 1.13:1 against --ground inside a
                  // .stage — the blocks were effectively invisible, so the heights carried
                  // nothing. --faint is a non-text token at 5.1:1 there, which draws the
                  // silhouette and clears the 3:1 floor for a meaningful graphic (1.4.11).
                  first ? 'bg-pen' : 'border-2 border-faint bg-overlay'
                }`}
              >
                <span
                  className={`font-display text-3xl lg:text-5xl ${
                    first ? 'text-pen-on' : 'text-dim'
                  }`}
                >
                  {rank}
                </span>
              </div>
            </div>
          )
        })}
      </div>

      {rest.length > 0 && (
        <section className="min-w-0 min-[1380px]:w-[30rem] min-[1380px]:shrink-0">
          <h3 className="mb-4 text-lg font-semibold text-dim lg:mb-6 lg:text-2xl">Everyone else</h3>
          {/* No rank-delta chips here. "+2" answers "since the last question", and on the
              final standings there is no next question for it to be measured against. */}
          <Leaderboard entries={rest} highlightId={highlightId} compact showDelta={false} />
        </section>
      )}
    </div>
  )
}
