// Server-authoritative quiz scoring. Pure + deterministic so it's unit-testable and
// reusable wherever a score is computed. Spec: docs/schema.md → "Scoring formula".

export const SCORING = {
  BASE: 1000,
  SPEED_FACTOR: 0.5, // instant-correct = BASE; buzzer-correct = BASE*(1-SPEED_FACTOR)
  STREAK_STEP: 50,
  STREAK_CAP_STEPS: 5, // streak bonus caps at STREAK_STEP * STREAK_CAP_STEPS (= 250)
} as const

export interface ScoreResult {
  /** total awarded = speed points + streak bonus (0 if the answer is wrong) */
  points: number
  /** speed component before the streak bonus (for display / debug) */
  base: number
  /** streak bonus component */
  streakBonus: number
  /** streak to persist on the participant (0 if wrong) */
  newStreak: number
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n))

/**
 * Score one quiz answer.
 * @param priorStreak participant's consecutive-correct count BEFORE this answer.
 * Late answers (past the time window) must be rejected by the endpoint before this is
 * called; the speed ratio is still clamped to [0,1] defensively (clock skew, races).
 */
export function scoreAnswer(
  params: { correct: boolean; responseMs: number; timeLimitMs: number; priorStreak: number },
  config = SCORING,
): ScoreResult {
  const { correct, responseMs, timeLimitMs, priorStreak } = params
  if (!correct) return { points: 0, base: 0, streakBonus: 0, newStreak: 0 }

  const { BASE, SPEED_FACTOR, STREAK_STEP, STREAK_CAP_STEPS } = config
  const ratio = timeLimitMs > 0 ? clamp(responseMs / timeLimitMs, 0, 1) : 0
  const base = clamp(
    Math.round(BASE * (1 - SPEED_FACTOR * ratio)),
    Math.round(BASE * (1 - SPEED_FACTOR)),
    BASE,
  )
  const newStreak = priorStreak + 1
  const streakBonus = STREAK_STEP * Math.min(newStreak, STREAK_CAP_STEPS)
  return { points: base + streakBonus, base, streakBonus, newStreak }
}
