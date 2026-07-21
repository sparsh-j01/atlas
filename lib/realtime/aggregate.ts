// Pure aggregation for the live views. Kept side-effect-free so it's unit-testable and
// reusable by any endpoint. Spec: docs/schema.md → "Realtime contracts".
import type { AggregateMcq, LeaderboardEntry } from './events'

/** Tally chosen options into `{ counts, total }` (computed on read — no stored counter). */
export function tallyMcq(rows: { optionId: string }[]): AggregateMcq {
  const counts: Record<string, number> = {}
  for (const { optionId } of rows) counts[optionId] = (counts[optionId] ?? 0) + 1
  return { counts, total: rows.length }
}

type Ranked = { participantId: string; nickname: string; avatarSeed: string; score: number }

/**
 * Rank participants for the leaderboard and compute each entry's `delta` (rank movement
 * vs the last broadcast top-N; positive = moved up, 0 = new/unchanged). Ties break by
 * participantId so ordering is deterministic under load.
 */
export function rankLeaderboard(
  participants: Ranked[],
  lastTopN: { participantId: string; rank: number }[] | null | undefined,
  limit = 10,
): LeaderboardEntry[] {
  const prevRank = new Map((lastTopN ?? []).map((e) => [e.participantId, e.rank]))
  return [...participants]
    .sort((a, b) => b.score - a.score || a.participantId.localeCompare(b.participantId))
    .slice(0, limit)
    .map((p, i) => {
      const rank = i + 1
      const before = prevRank.get(p.participantId)
      return {
        participantId: p.participantId,
        nickname: p.nickname,
        avatarSeed: p.avatarSeed,
        score: p.score,
        rank,
        delta: before === undefined ? 0 : before - rank,
      }
    })
}
