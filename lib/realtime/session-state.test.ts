import { describe, it, expect } from 'vitest'
import { answersOpen } from './session-state'

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
