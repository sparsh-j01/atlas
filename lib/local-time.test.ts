import { describe, expect, it } from 'vitest'
import { formatLocalTime } from './local-time'

describe('formatLocalTime', () => {
  it('joins date and time itself, so every ICU build renders the same string', () => {
    // Node printed "6 Oct 2026 at 00:00" and Safari "6 Oct 2026, 00:00" from one combined
    // formatter; React threw a hydration mismatch on /usage.
    expect(formatLocalTime('2026-10-06T00:00:00.000Z', false, 'UTC')).toBe('6 Oct 2026, 00:00')
  })

  it('drops the time when asked for the date only', () => {
    expect(formatLocalTime('2026-10-06T23:30:00.000Z', true, 'UTC')).toBe('6 Oct 2026')
  })
})
