import { describe, expect, it } from 'vitest'
import { TEXT_POOR_MAX_CHARS, buildCoverageReport, isTextPoor } from '../coverage'
import { deriveSlideSections, slideHeading } from '../sections'

describe('isTextPoor', () => {
  it('needs BOTH too little text and an image to send a page to OCR', () => {
    expect(isTextPoor('', 1)).toBe(true)
    expect(isTextPoor('Title only', 1)).toBe(true)
    // No image: there is nothing for OCR to read, so running it would only cost time.
    expect(isTextPoor('', 0)).toBe(false)
    expect(isTextPoor('Title only', 0)).toBe(false)
  })

  it('leaves a slide with real text alone even when it has images', () => {
    expect(isTextPoor('x'.repeat(TEXT_POOR_MAX_CHARS), 3)).toBe(false)
    expect(isTextPoor('x'.repeat(TEXT_POOR_MAX_CHARS - 1), 3)).toBe(true)
  })

  it('does not count whitespace as text', () => {
    expect(isTextPoor('   \n\n\t  ', 1)).toBe(true)
  })
})

describe('buildCoverageReport', () => {
  it('says nothing when every page was read', () => {
    const report = buildCoverageReport(10, [])
    expect(report).toEqual({ totalPages: 10, readPages: 10, unread: [], message: '' })
  })

  it('names each unread slide and why, in page order', () => {
    const report = buildCoverageReport(40, [
      { pageNumber: 31, reason: 'image_only' },
      { pageNumber: 12, reason: 'parse_error' },
      { pageNumber: 19, reason: 'empty' },
    ])
    expect(report.readPages).toBe(37)
    expect(report.unread.map((u) => u.pageNumber)).toEqual([12, 19, 31])
    expect(report.message).toBe(
      '3 slides produced no text: slide 12 — could not be read · slide 19 — has no text on it · ' +
        'slide 31 — is an image with no text we could recognise',
    )
  })

  it('uses the singular for one slide', () => {
    const report = buildCoverageReport(5, [{ pageNumber: 2, reason: 'parse_error' }])
    expect(report.message).toBe('1 slide produced no text: slide 2 — could not be read')
  })
})

describe('deriveSlideSections', () => {
  // The pipeline joins pages with '\n\n', which is what these offsets model.
  const pages = [
    { pageNumber: 1, text: 'Photosynthesis\nAn overview', offset: 0 },
    { pageNumber: 2, text: 'Light reactions', offset: 28 },
    { pageNumber: 3, text: 'The Calvin cycle', offset: 45 },
  ]

  it('makes exactly one section per slide, with no model call', () => {
    const sections = deriveSlideSections(pages)
    expect(sections).toHaveLength(3)
    expect(sections.map((s) => [s.pageStart, s.pageEnd])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })

  it('produces offsets that slice back to exactly that slide', () => {
    // This is the provenance invariant the chunker depends on. Derived offsets satisfy it
    // by construction, which is the point of not asking a model for them.
    const fullText = pages.map((p) => p.text).join('\n\n')
    for (const section of deriveSlideSections(pages)) {
      const slide = pages.find((p) => p.pageNumber === section.pageStart)!
      expect(fullText.slice(section.startOffset, section.endOffset)).toBe(slide.text)
    }
  })

  it('titles each section from the slide\'s first line', () => {
    expect(deriveSlideSections(pages).map((s) => s.heading)).toEqual([
      'Photosynthesis',
      'Light reactions',
      'The Calvin cycle',
    ])
  })

  it('skips slides with no text rather than emitting a zero-width section', () => {
    const withBlank = [
      { pageNumber: 1, text: 'Real', offset: 0 },
      { pageNumber: 2, text: '', offset: 6 },
      { pageNumber: 3, text: 'Also real', offset: 8 },
    ]
    expect(deriveSlideSections(withBlank).map((s) => s.pageStart)).toEqual([1, 3])
  })

  it('never returns a blank heading', () => {
    expect(slideHeading('', 7)).toBe('Slide 7')
    expect(slideHeading('\n\n   \n', 7)).toBe('Slide 7')
  })

  it('truncates a heading that is really a paragraph', () => {
    const heading = slideHeading('x'.repeat(500), 1)
    expect(heading).toHaveLength(200)
    expect(heading.endsWith('...')).toBe(true)
  })
})
