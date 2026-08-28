'use client'

import { useInView, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Leaderboard } from '@/components/Leaderboard'
import type { LeaderboardEntry } from '@/lib/realtime/events'

// The product's own Leaderboard component, driven by seeded scores. Rendering the real
// component rather than a mock of it means this preview cannot drift from the live board,
// and the reorder you watch here is the reorder the room watches: rows are positioned
// absolutely and moved by transform, so each row keeps its identity across a re-rank.

const PLAYERS = [
  { participantId: 'p1', nickname: 'nimbus', avatarSeed: 'nimbus' },
  { participantId: 'p2', nickname: 'Devansh K', avatarSeed: 'devansh-k' },
  { participantId: 'p3', nickname: 'theo.b', avatarSeed: 'theo-b' },
  { participantId: 'p4', nickname: 'Ritika', avatarSeed: 'ritika' },
]

// Nobody holds first the whole way and the gaps are uneven, which is what real scoring
// looks like once speed bonuses are in play.
const ROUNDS: number[][] = [
  [1840, 1720, 1655, 1590],
  [2612, 2845, 2390, 2733],
  [3481, 3702, 3615, 3944],
]

const ROUND_MS = 3000

function toEntries(scores: number[], previous: number[] | null): LeaderboardEntry[] {
  const rankOf = (list: number[]) => {
    const order = list.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s)
    const ranks: number[] = []
    order.forEach((o, position) => {
      ranks[o.i] = position + 1
    })
    return ranks
  }
  const ranks = rankOf(scores)
  const prevRanks = previous ? rankOf(previous) : null
  return PLAYERS.map((p, i) => ({
    ...p,
    score: scores[i],
    rank: ranks[i],
    // Positive is a climb, so it is the previous rank minus the current one.
    delta: prevRanks ? prevRanks[i] - ranks[i] : 0,
  }))
}

export function RerankDemo() {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { amount: 0.5 })
  const reduce = useReducedMotion()
  const [round, setRound] = useState(0)

  useEffect(() => {
    // Reduced motion gets the finished board, not a slideshow of it.
    if (!inView || reduce) return
    const t = setInterval(() => setRound((r) => (r + 1) % ROUNDS.length), ROUND_MS)
    return () => clearInterval(t)
  }, [inView, reduce])

  const i = reduce ? ROUNDS.length - 1 : round
  const entries = toEntries(ROUNDS[i], i === 0 ? null : ROUNDS[i - 1])

  return (
    <div ref={ref}>
      <Leaderboard entries={entries} />
    </div>
  )
}
