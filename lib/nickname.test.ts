import { describe, it, expect } from 'vitest'
import { foldForMatch, isBlockedNickname, sanitizeNickname } from './nickname'

describe('foldForMatch', () => {
  it('collapses the obfuscations people actually use', () => {
    // Every one of these is the same word to a reader and a different string to `includes`.
    for (const variant of ['fuck', 'FUCK', 'f.u.c.k', 'fuuuuck', 'Ｆｕｃｋ', 'f-u-c-k', 'f u c k']) {
      expect(foldForMatch(variant)).toBe('fuck')
    }
    expect(foldForMatch('sh1t')).toBe('shit') // digit standing in for the letter it looks like
  })

  // Honest about the ceiling rather than pretending: a digit only folds to the letter it
  // RESEMBLES, so substituting a different vowel walks straight past this. Widening the map
  // to cover it would start rejecting ordinary words, which is a worse trade at a school
  // quiz than one miss the host can kick. Documented here so nobody "fixes" it by accident.
  it('does NOT catch a substitution that changes the vowel — that is what the kick is for', () => {
    expect(foldForMatch('f4ck')).toBe('fack')
    expect(isBlockedNickname('f4ck')).toBe(false)
  })

  it('strips accents rather than treating them as different letters', () => {
    expect(foldForMatch('shít')).toBe('shit')
  })
})

describe('isBlockedNickname', () => {
  it('catches the plain spelling and the padded ones', () => {
    expect(isBlockedNickname('fuck')).toBe(true)
    expect(isBlockedNickname('xX_fUcK_Xx')).toBe(true)
    expect(isBlockedNickname('sh1t lord')).toBe(true)
  })

  it('leaves ordinary nicknames alone', () => {
    for (const ok of ['Sparsh', 'Ms. Patel', 'team 7', 'Anna-Maria', 'Ravi K.', 'Cocoa']) {
      expect(isBlockedNickname(ok)).toBe(false)
    }
  })
})

describe('sanitizeNickname', () => {
  it('returns the exact string to store, whitespace-collapsed', () => {
    expect(sanitizeNickname('  Ravi   K.  ')).toEqual({ ok: true, nickname: 'Ravi K.' })
  })

  it('rejects a name that is only invisible characters', () => {
    // Renders as a blank row on the projector, which is its own kind of griefing.
    expect(sanitizeNickname('​​​').ok).toBe(false)
  })

  it('checks length after stripping, so padding buys no extra characters', () => {
    expect(sanitizeNickname(`${' '.repeat(40)}Ana${' '.repeat(40)}`)).toEqual({
      ok: true,
      nickname: 'Ana',
    })
    expect(sanitizeNickname('a'.repeat(25)).ok).toBe(false)
  })

  it('rejects non-strings and blocked names without naming the match', () => {
    expect(sanitizeNickname(undefined).ok).toBe(false)
    expect(sanitizeNickname(42).ok).toBe(false)
    const blocked = sanitizeNickname('n1gger')
    expect(blocked.ok).toBe(false)
    // The error must not echo the word back — that turns it into a probe oracle.
    expect(blocked.ok === false && blocked.error).toBe('Pick a different nickname.')
  })
})
