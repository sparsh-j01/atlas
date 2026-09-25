import { describe, expect, it } from 'vitest'
import { MIN_OCR_CHARS, canOcr, isUsableOcrText, normalizeOcrText } from '../ocr'

describe('canOcr', () => {
  it('accepts the inline image types Gemini reads', () => {
    for (const t of ['image/png', 'image/jpeg', 'image/webp']) expect(canOcr(t), t).toBe(true)
  })

  it('refuses formats Gemini does not take inline, and vector metafiles with no raster', () => {
    for (const t of ['image/gif', 'image/bmp', 'image/tiff', 'image/x-emf', 'image/x-wmf', 'image/svg+xml'])
      expect(canOcr(t), t).toBe(false)
  })

  it('refuses anything that is not an image at all', () => {
    expect(canOcr('application/octet-stream')).toBe(false)
    expect(canOcr('video/mp4')).toBe(false)
    expect(canOcr('')).toBe(false)
  })
})

describe('isUsableOcrText', () => {
  it('keeps text that reads like language', () => {
    expect(isUsableOcrText('The light-dependent reactions occur in the thylakoid membrane')).toBe(true)
    expect(isUsableOcrText('Figure 3: ATP synthase')).toBe(true)
  })

  it('rejects the stray marks a photograph or gradient comes back as', () => {
    // Storing this would put text into retrieval that the document does not contain.
    expect(isUsableOcrText('~ | !! .. ,, ~~ || ^^')).toBe(false)
    expect(isUsableOcrText('|][{}!@#$%^&*()_+|][{}')).toBe(false)
  })

  it('rejects text too short to be worth a chunk', () => {
    expect(isUsableOcrText('ATP')).toBe(false)
    expect(isUsableOcrText('x'.repeat(MIN_OCR_CHARS - 1))).toBe(false)
    expect(isUsableOcrText('x'.repeat(MIN_OCR_CHARS))).toBe(true)
  })

  it('rejects empty and whitespace-only output', () => {
    expect(isUsableOcrText('')).toBe(false)
    expect(isUsableOcrText('   \n\n \t ')).toBe(false)
  })

  it('keeps non-latin text', () => {
    expect(isUsableOcrText('光合作用は葉緑体で起こる反応です')).toBe(true)
  })
})

describe('normalizeOcrText', () => {
  it('collapses layout whitespace without joining words', () => {
    expect(normalizeOcrText('The   light     reactions\n\n\n  occur   here  ')).toBe(
      'The light reactions\noccur here',
    )
  })

  it('drops blank lines and trims', () => {
    expect(normalizeOcrText('\n\n  A  \n\n\n B \n\n')).toBe('A\nB')
  })

  it('returns empty for nothing recognised', () => {
    expect(normalizeOcrText('   \n\n\t')).toBe('')
  })
})
