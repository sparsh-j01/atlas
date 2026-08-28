import { describe, expect, it } from 'vitest'
import {
  ACCEPTED_MIME_TYPES,
  FORMATS,
  PDF_FORMAT,
  PPTX_FORMAT,
  acceptedLabels,
  formatForId,
  formatForMime,
  matchesMagic,
} from '../formats'
import { buildZip, pictureShape, relsXml, slideXml, textShape } from './zip-fixtures'

const bytes = (...b: number[]) => new Uint8Array(b)

describe('the registry', () => {
  it('lists exactly the formats the product accepts', () => {
    expect(FORMATS.map((f) => f.id)).toEqual(['pdf', 'pptx'])
  })

  it('resolves a format by its MIME type', () => {
    expect(formatForMime('application/pdf')?.id).toBe('pdf')
    expect(
      formatForMime('application/vnd.openxmlformats-officedocument.presentationml.presentation')?.id,
    ).toBe('pptx')
  })

  it('resolves nothing for a type that is not accepted', () => {
    expect(formatForMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeUndefined()
    expect(formatForMime('image/png')).toBeUndefined()
    expect(formatForMime('')).toBeUndefined()
    expect(formatForMime('application/pdf; charset=utf-8')).toBeUndefined()
  })

  it('resolves a format by its stored source_type', () => {
    expect(formatForId('pptx')?.mimeType).toBe(PPTX_FORMAT.mimeType)
    expect(formatForId('docx')).toBeUndefined()
  })

  it('exposes one list every consumer reads, so no allowlist drifts', () => {
    expect(ACCEPTED_MIME_TYPES).toEqual(FORMATS.map((f) => f.mimeType))
    expect(acceptedLabels()).toBe('PDF or PowerPoint file')
  })
})

describe('magic bytes', () => {
  it('accepts the leading bytes of each format', () => {
    expect(matchesMagic(PDF_FORMAT, bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31))).toBe(true)
    expect(matchesMagic(PPTX_FORMAT, bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe(true)
  })

  it('rejects a file whose declared type does not match its bytes', () => {
    expect(matchesMagic(PDF_FORMAT, bytes(0x50, 0x4b, 0x03, 0x04))).toBe(false)
    expect(matchesMagic(PPTX_FORMAT, bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe(false)
  })

  it('rejects a file too short to carry the magic at all', () => {
    expect(matchesMagic(PDF_FORMAT, bytes(0x25, 0x50))).toBe(false)
    expect(matchesMagic(PPTX_FORMAT, new Uint8Array(0))).toBe(false)
  })
})

describe('pptx probe', () => {
  const deck = (bodies: string[], extra: { path: string; data: string | Uint8Array }[] = []) =>
    buildZip([
      ...bodies.map((b, i) => ({ path: `ppt/slides/slide${i + 1}.xml`, data: slideXml(b) })),
      ...extra,
    ])

  it('accepts a deck and reports its slide count', async () => {
    const zip = deck([textShape('One'), textShape('Two'), textShape('Three')])
    expect(await PPTX_FORMAT.probe(zip, 200)).toEqual({ ok: true, pageCount: 3 })
  })

  it('rejects a deck over the slide limit', async () => {
    const zip = deck(Array.from({ length: 5 }, (_, i) => textShape(`S${i}`)))
    expect(await PPTX_FORMAT.probe(zip, 4)).toEqual({ ok: false, error: 'Too many slides. Maximum 4.' })
  })

  it('accepts an image-only deck, because OCR runs later', async () => {
    // The PDF path rejects this outright; the PPTX path does not, because the images are
    // already image files and tesseract can read them.
    const zip = deck([pictureShape('rId2')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId2: '../media/image1.png' }) },
      { path: 'ppt/media/image1.png', data: 'PNG' },
    ])
    expect(await PPTX_FORMAT.probe(zip, 200)).toEqual({ ok: true, pageCount: 1 })
  })

  it('rejects a deck with neither text nor images', async () => {
    const result = await PPTX_FORMAT.probe(deck(['', '']), 200)
    expect(result).toEqual({ ok: false, error: 'That presentation has no text and no images on any slide.' })
  })

  it('rejects another OOXML file that shares the same magic bytes', async () => {
    // .docx, .xlsx and .pptx all begin PK\x03\x04. Only the probe can tell them apart.
    const docx = buildZip([{ path: 'word/document.xml', data: '<document/>' }])
    expect(matchesMagic(PPTX_FORMAT, docx)).toBe(true)
    expect(await PPTX_FORMAT.probe(docx, 200)).toEqual({
      ok: false,
      error: 'That file is not a PowerPoint presentation.',
    })
  })

  it('rejects a zip bomb without leaking the limit detail', async () => {
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: 'x', declaredSize: 4_000_000_000 }])
    expect(await PPTX_FORMAT.probe(zip, 200)).toEqual({
      ok: false,
      error: 'That presentation is too large once unpacked.',
    })
  })

  it('rejects a file that is not a zip at all', async () => {
    const result = await PPTX_FORMAT.probe(new TextEncoder().encode('just text'), 200)
    expect(result.ok).toBe(false)
  })
})

describe('pdf probe', () => {
  it('rejects a non-PDF without throwing or leaking parser internals', async () => {
    const result = await PDF_FORMAT.probe(new TextEncoder().encode('not a pdf'), 200)
    expect(result).toEqual({ ok: false, error: 'That PDF could not be read. It may be corrupted.' })
  })

  it('keeps the PDF rejection copy the route shipped with', async () => {
    // These sentences are what a teacher reads; a regression here is a product regression.
    const result = await PDF_FORMAT.probe(new Uint8Array(0), 200)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/could not be read|no pages/)
  })
})
