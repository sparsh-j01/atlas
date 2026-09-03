// Pure aggregation for the live views. Kept side-effect-free so it's unit-testable and
// reusable by any endpoint. Spec: docs/schema.md → "Realtime contracts".
import type { AggregateMcq, LeaderboardEntry } from './events'

/** Tally chosen options into `{ counts, total }` (computed on read — no stored counter). */
export function tallyMcq(rows: { optionId: string }[]): AggregateMcq {
  const counts: Record<string, number> = {}
  for (const { optionId } of rows) counts[optionId] = (counts[optionId] ?? 0) + 1
  return { counts, total: rows.length }
}

/**
 * The lobby roster the projector renders: connected ids resolved against server-issued
 * names, in a stable order.
 *
 * This is a security boundary, not a formatting helper. Presence payloads are written by
 * clients and migration 0005's policy cannot tell a participant from anyone else holding
 * the public anon key and the projected 6-digit code, so a name taken from a presence
 * payload has never passed sanitizeNickname and cannot be removed by /kick (which deletes
 * a participants row a forged entry never had). Resolving through `named` — built from
 * GET /roster, i.e. the rows the join endpoint wrote — means an id nobody was issued
 * resolves to nothing and never reaches the screen.
 *
 * Sorted by participant id, for the same reason rankLeaderboard breaks ties on it. Presence
 * order is whatever order the channel's state object happens to enumerate: stable within one
 * connection (a new join appends), but a host reload re-subscribes and the whole wall of
 * names rearranges in front of the class for no reason anyone can see.
 */
export function resolveRoster<T>(liveIds: string[], named: Map<string, T>): T[] {
  return [...liveIds]
    .sort((a, b) => a.localeCompare(b))
    .flatMap((id) => named.get(id) ?? [])
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
