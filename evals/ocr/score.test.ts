import { describe, expect, it } from 'vitest'
import { tokenF1, words } from './score'

describe('OCR scoring', () => {
  it('ignores case, punctuation and layout', () => {
    expect(words('• CoAP Client,\n Web-Connectivity')).toEqual(['coap', 'client', 'web', 'connectivity'])
    expect(tokenF1('CoAP Client', 'coap\nclient')).toBe(1)
  })

  it('punishes dropped words (recall) and invented ones (precision)', () => {
    expect(tokenF1('a b c d', 'a b')).toBeCloseTo(2 / 3)
    expect(tokenF1('a b', 'a b c d')).toBeCloseTo(2 / 3)
  })

  it('counts repeats, so a word read twice is not two hits', () => {
    expect(tokenF1('data', 'data data')).toBeCloseTo(2 / 3)
  })

  it('scores an empty image read as empty as a match, and garbage for text as 0', () => {
    expect(tokenF1('', '')).toBe(1)
    expect(tokenF1('real words', '')).toBe(0)
  })
})
