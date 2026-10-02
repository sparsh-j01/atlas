// Pure aggregation for the live views. Kept side-effect-free so it's unit-testable and
// reusable by any endpoint. Spec: docs/schema.md → "Realtime contracts".
import type { LeaderboardEntry } from './events'

type Ranked = { participantId: string; nickname: string; avatarSeed: string; score: number }

/** Rank participants for the leaderboard. Ties break by participantId so ordering is
 *  deterministic under load. */
export function rankLeaderboard(participants: Ranked[], limit = 10): LeaderboardEntry[] {
  return [...participants]
    .sort((a, b) => b.score - a.score || a.participantId.localeCompare(b.participantId))
    .slice(0, limit)
    .map((p, i) => ({
      participantId: p.participantId,
      nickname: p.nickname,
      avatarSeed: p.avatarSeed,
      score: p.score,
      rank: i + 1,
    }))
}
