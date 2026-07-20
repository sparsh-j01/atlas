import { describe, it, expect } from 'vitest'
import { scoreAnswer, SCORING } from './scoring'

const T = 20_000 // 20s time limit

describe('scoreAnswer', () => {
  it('wrong answer scores 0 and resets the streak', () => {
    const r = scoreAnswer({ correct: false, responseMs: 1000, timeLimitMs: T, priorStreak: 4 })
    expect(r).toEqual({ points: 0, base: 0, streakBonus: 0, newStreak: 0 })
  })

  it('instant correct earns full base + first streak step', () => {
    const r = scoreAnswer({ correct: true, responseMs: 0, timeLimitMs: T, priorStreak: 0 })
    expect(r.base).toBe(1000)
    expect(r.streakBonus).toBe(50)
    expect(r.points).toBe(1050)
    expect(r.newStreak).toBe(1)
  })

  it('buzzer-beater correct floors at half base', () => {
    const r = scoreAnswer({ correct: true, responseMs: T, timeLimitMs: T, priorStreak: 0 })
    expect(r.base).toBe(500) // BASE * (1 - SPEED_FACTOR)
    expect(r.points).toBe(550)
  })

  it('half-time correct scales linearly', () => {
    const r = scoreAnswer({ correct: true, responseMs: T / 2, timeLimitMs: T, priorStreak: 0 })
    expect(r.base).toBe(750) // 1000 * (1 - 0.5 * 0.5)
  })

  it('streak bonus caps at STREAK_CAP_STEPS', () => {
    const r = scoreAnswer({ correct: true, responseMs: 0, timeLimitMs: T, priorStreak: 10 })
    expect(r.streakBonus).toBe(SCORING.STREAK_STEP * SCORING.STREAK_CAP_STEPS) // 250
    expect(r.points).toBe(1250)
    expect(r.newStreak).toBe(11)
  })

  it('clamps a late answer (ratio > 1) to the floor', () => {
    const r = scoreAnswer({ correct: true, responseMs: T * 2, timeLimitMs: T, priorStreak: 0 })
    expect(r.base).toBe(500)
  })

  it('clamps negative response time (clock skew) to full base', () => {
    const r = scoreAnswer({ correct: true, responseMs: -500, timeLimitMs: T, priorStreak: 0 })
    expect(r.base).toBe(1000)
  })

  it('guards against a non-positive time limit (no NaN)', () => {
    const r = scoreAnswer({ correct: true, responseMs: 100, timeLimitMs: 0, priorStreak: 0 })
    expect(r.base).toBe(1000)
    expect(Number.isNaN(r.points)).toBe(false)
  })
})
