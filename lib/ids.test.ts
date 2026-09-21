import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { isRoomCode, isShareToken, isUuid } from './ids'

// Each of these reached Postgres in the 2026-10-04 fuzz run and came back as a 500.
describe('identifier format checks', () => {
  it('isUuid takes any hyphenated uuid and nothing Postgres would error on', () => {
    expect(isUuid(randomUUID())).toBe(true)
    expect(isUuid(randomUUID().toUpperCase())).toBe(true)
    for (const bad of ['garbage', 'ab\0cd', randomUUID() + 'x', `{${randomUUID()}}`, 'x'.repeat(2000), '', 42, null, undefined, {}])
      expect(isUuid(bad)).toBe(false)
  })

  it('isRoomCode is exactly six ASCII digits', () => {
    expect(isRoomCode('012345')).toBe(true)
    for (const bad of ['12345', '1234567', '12\x0034', 'abcdef', '١٢٣٤٥٦', "1' OR '1'='1", 123456])
      expect(isRoomCode(bad)).toBe(false)
  })

  it('isShareToken is bounded base64url', () => {
    expect(isShareToken('Zk3_x-9QaB1cD2eF3gH4iJ')).toBe(true)
    for (const bad of ['', 'a\0b', 'a/b', 'x'.repeat(65), null]) expect(isShareToken(bad)).toBe(false)
  })
})
