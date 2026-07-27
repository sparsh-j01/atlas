import { describe, it, expect } from 'vitest'
import { ANSWER_GRACE_MS, answersOpen, withinAnswerWindow } from './session-state'
import { SCORING, scoreAnswer } from './scoring'

const startedAt = new Date('2026-07-22T00:00:00Z')

describe('answersOpen (reveal-gate)', () => {
  it('accepts answers while the question is live', () => {
    expect(answersOpen({ status: 'active', currentSlideStartedAt: startedAt })).toBe(true)
  })

  it('closes the window once the host reveals — the anti-cheat gate', () => {
    expect(answersOpen({ status: 'revealed', currentSlideStartedAt: startedAt })).toBe(false)
  })

  it('rejects lobby, ended, and not-yet-started sessions', () => {
    expect(answersOpen({ status: 'lobby', currentSlideStartedAt: null })).toBe(false)
    expect(answersOpen({ status: 'ended', currentSlideStartedAt: startedAt })).toBe(false)
    expect(answersOpen({ status: 'active', currentSlideStartedAt: null })).toBe(false)
  })
})

describe('withinAnswerWindow (network grace)', () => {
  const limit = 20_000

  it('accepts an answer that arrives inside the grace, and rejects one past it', () => {
    expect(withinAnswerWindow(limit, limit)).toBe(true) // exactly on the deadline
    expect(withinAnswerWindow(limit + ANSWER_GRACE_MS, limit)).toBe(true) // uploaded slowly
    expect(withinAnswerWindow(limit + ANSWER_GRACE_MS + 1, limit)).toBe(false)
  })

  // The grace is only defensible because it can't be farmed: the speed ratio clamps at 1,
  // so everything inside it scores the floor. If someone widens ANSWER_GRACE_MS without
  // re-checking that, this is what catches it.
  it('pays the floor for a grace-window answer — being late can never beat being on time', () => {
    const late = scoreAnswer({
      correct: true,
      responseMs: limit + ANSWER_GRACE_MS,
      timeLimitMs: limit,
      priorStreak: 0,
    })
    const onTime = scoreAnswer({
      correct: true,
      responseMs: limit,
      timeLimitMs: limit,
      priorStreak: 0,
    })
    expect(late.base).toBe(Math.round(SCORING.BASE * (1 - SCORING.SPEED_FACTOR)))
    expect(late.points).toBe(onTime.points)
  })
})
