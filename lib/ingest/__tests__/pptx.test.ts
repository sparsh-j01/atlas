import { describe, expect, it } from 'vitest'
import { NOTES_LABEL, extractPptx, extractSlideContent } from '../pptx'
import { decodeEntities, scanXml, attr } from '../xml'
import { ZipLimitError } from '../zip'
import { buildZip, pictureShape, relsXml, slideXml, tableShape, textShape } from './zip-fixtures'

/** A .pptx with `n` slides, built from raw slide-body markup. */
function deck(bodies: string[], extra: { path: string; data: string | Uint8Array }[] = []) {
  return buildZip([
    ...bodies.map((b, i) => ({ path: `ppt/slides/slide${i + 1}.xml`, data: slideXml(b) })),
    ...extra,
  ])
}

describe('slide text extraction', () => {
  it('reads paragraphs as lines, in document order', () => {
    const xml = slideXml(textShape('Photosynthesis', 'Light-dependent reactions', 'Calvin cycle'))
    expect(extractSlideContent(xml).text).toBe(
      'Photosynthesis\nLight-dependent reactions\nCalvin cycle',
    )
  })

  it('keeps multiple shapes in the order they appear', () => {
    const xml = slideXml(textShape('Title') + textShape('Body one') + textShape('Body two'))
    expect(extractSlideContent(xml).text).toBe('Title\nBody one\nBody two')
  })

  it('joins runs within a paragraph without inserting a break', () => {
    const xml = slideXml('<p:sp><p:txBody><a:p><a:r><a:t>Photo</a:t></a:r><a:r><a:t>synthesis</a:t></a:r></a:p></p:txBody></p:sp>')
    expect(extractSlideContent(xml).text).toBe('Photosynthesis')
  })

  it('treats a soft break as a space, not a word join', () => {
    const xml = slideXml('<p:sp><p:txBody><a:p><a:r><a:t>light</a:t></a:r><a:br/><a:r><a:t>reaction</a:t></a:r></a:p></p:txBody></p:sp>')
    expect(extractSlideContent(xml).text).toBe('light reaction')
  })

  it('ignores markup outside text runs', () => {
    const xml = slideXml('<p:sp><p:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr><p:txBody><a:p><a:r><a:t>Only this</a:t></a:r></a:p></p:txBody></p:sp>')
    expect(extractSlideContent(xml).text).toBe('Only this')
  })

  it('drops empty paragraphs rather than emitting blank lines', () => {
    const xml = slideXml(textShape('One', '', '   ', 'Two'))
    expect(extractSlideContent(xml).text).toBe('One\nTwo')
  })
})

describe('tables', () => {
  it('flattens rows in reading order, cells joined by a pipe', () => {
    const xml = slideXml(
      tableShape([
        ['Phase', 'Location', 'Output'],
        ['Light', 'Thylakoid', 'ATP'],
        ['Calvin', 'Stroma', 'Glucose'],
      ]),
    )
    expect(extractSlideContent(xml).text).toBe(
      'Phase | Location | Output\nLight | Thylakoid | ATP\nCalvin | Stroma | Glucose',
    )
  })

  it('preserves column position when a cell is empty', () => {
    const xml = slideXml(tableShape([['A', '', 'C']]))
    expect(extractSlideContent(xml).text).toBe('A |  | C')
  })

  it('keeps a table in position relative to the text around it', () => {
    const xml = slideXml(textShape('Before') + tableShape([['a', 'b']]) + textShape('After'))
    expect(extractSlideContent(xml).text).toBe('Before\na | b\nAfter')
  })

  it('handles a multi-paragraph cell without breaking the row', () => {
    const xml = slideXml(
      '<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>one</a:t></a:r></a:p><a:p><a:r><a:t>two</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>',
    )
    expect(extractSlideContent(xml).text).toBe('one two | x')
  })
})

describe('speaker notes', () => {
  it('appends notes to the slide, behind a label', () => {
    const zip = deck([textShape('Mitosis')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId1: '../notesSlides/notesSlide1.xml' }) },
      { path: 'ppt/notesSlides/notesSlide1.xml', data: slideXml(textShape('Mention the spindle')) },
    ])
    const { pages } = extractPptx(zip)
    expect(pages[0].text).toBe(`Mitosis\n\n${NOTES_LABEL}\nMention the spindle`)
  })

  it('follows the relationship rather than the filename, so mismatched numbering still pairs', () => {
    // Only slide 2 has notes, so PowerPoint names them notesSlide1.xml.
    const zip = deck([textShape('First'), textShape('Second')], [
      { path: 'ppt/slides/_rels/slide2.xml.rels', data: relsXml({ rId1: '../notesSlides/notesSlide1.xml' }) },
      { path: 'ppt/notesSlides/notesSlide1.xml', data: slideXml(textShape('Belongs to slide two')) },
    ])
    const { pages } = extractPptx(zip)
    expect(pages[0].text).toBe('First')
    expect(pages[1].text).toContain('Belongs to slide two')
  })

  it('drops the slide-number placeholder the notes part repeats', () => {
    const zip = deck([textShape('Body')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId1: '../notesSlides/notesSlide1.xml' }) },
      { path: 'ppt/notesSlides/notesSlide1.xml', data: slideXml(textShape('1', 'Real note')) },
    ])
    expect(extractPptx(zip).pages[0].text).toBe(`Body\n\n${NOTES_LABEL}\nReal note`)
  })

  it('adds no label when a slide has no notes', () => {
    expect(extractPptx(deck([textShape('Alone')])).pages[0].text).toBe('Alone')
  })
})

describe('image metadata', () => {
  it('records the zip entry path, and copies no bytes', () => {
    const zip = deck([textShape('Diagram') + pictureShape('rId2')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId2: '../media/image1.png' }) },
      { path: 'ppt/media/image1.png', data: 'PNGDATA' },
    ])
    const { assets } = extractPptx(zip)
    expect(assets).toEqual([
      { pageNumber: 1, assetIndex: 0, entryPath: 'ppt/media/image1.png', mimeType: 'image/png' },
    ])
    expect(assets[0]).not.toHaveProperty('bytes')
  })

  it('indexes two images on one slide separately', () => {
    const zip = deck([pictureShape('rId2') + pictureShape('rId3')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId2: '../media/a.png', rId3: '../media/b.jpeg' }) },
      { path: 'ppt/media/a.png', data: 'A' },
      { path: 'ppt/media/b.jpeg', data: 'B' },
    ])
    const { assets } = extractPptx(zip)
    expect(assets.map((a) => [a.assetIndex, a.mimeType])).toEqual([
      [0, 'image/png'],
      [1, 'image/jpeg'],
    ])
  })

  it('ignores a relationship pointing outside ppt/media', () => {
    const zip = deck([pictureShape('rId9')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId9: '../../../etc/passwd' }) },
    ])
    expect(extractPptx(zip).assets).toEqual([])
  })

  it('ignores a relationship whose media is not in the archive', () => {
    const zip = deck([pictureShape('rId2')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId2: '../media/missing.png' }) },
    ])
    expect(extractPptx(zip).assets).toEqual([])
  })
})

describe('slide ordering and numbering', () => {
  it('sorts numerically, so slide10 comes after slide2', () => {
    const bodies = Array.from({ length: 12 }, (_, i) => textShape(`Slide ${i + 1}`))
    const { pages } = extractPptx(deck(bodies))
    expect(pages).toHaveLength(12)
    expect(pages.map((p) => p.text)).toEqual(bodies.map((_, i) => `Slide ${i + 1}`))
  })

  it('numbers pages densely even when a slide is unreadable', () => {
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: slideXml(textShape('One')) },
      { path: 'ppt/slides/slide2.xml', data: 'not xml at all' },
      { path: 'ppt/slides/slide3.xml', data: slideXml(textShape('Three')) },
    ])
    const { pages } = extractPptx(zip)
    expect(pages.map((p) => p.pageNumber)).toEqual([1, 2, 3])
    expect(pages[2].text).toBe('Three')
  })
})

describe('unreadable and empty slides', () => {
  it('records a malformed slide and keeps the rest of the deck', () => {
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: slideXml(textShape('Good')) },
      { path: 'ppt/slides/slide2.xml', data: '<<<not markup' },
      { path: 'ppt/slides/slide3.xml', data: slideXml(textShape('Also good')) },
    ])
    const { pages } = extractPptx(zip)
    expect(pages[1]).toEqual({ pageNumber: 2, text: '', unreadReason: 'parse_error' })
    expect(pages.filter((p) => p.text).length).toBe(2)
  })

  it('never throws for a slide-level problem', () => {
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: new Uint8Array([0xff, 0xfe, 0x00, 0x01]) }])
    expect(() => extractPptx(zip)).not.toThrow()
    expect(extractPptx(zip).pages[0].unreadReason).toBe('parse_error')
  })

  it('marks a text-free slide with images as image_only', () => {
    const zip = deck([pictureShape('rId2')], [
      { path: 'ppt/slides/_rels/slide1.xml.rels', data: relsXml({ rId2: '../media/image1.png' }) },
      { path: 'ppt/media/image1.png', data: 'PNG' },
    ])
    expect(extractPptx(zip).pages[0].unreadReason).toBe('image_only')
  })

  it('marks a genuinely blank slide as empty, not as an error', () => {
    expect(extractPptx(deck([''])).pages[0].unreadReason).toBe('empty')
  })

  it('leaves a slide with text unmarked', () => {
    expect(extractPptx(deck([textShape('Content')])).pages[0].unreadReason).toBeUndefined()
  })

  it('rejects an archive with no slides at all', () => {
    expect(() => extractPptx(buildZip([{ path: 'ppt/media/image1.png', data: 'x' }]))).toThrow(/no slides/)
  })

  it('propagates a decompression limit rather than returning a partial deck', () => {
    // The per-slide catch must not turn an archive-level refusal into "one bad slide".
    // Declared sizes are a uint32 the archive chooses, so 4GB costs three bytes to claim.
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: 'x', declaredSize: 4_000_000_000 }])
    expect(() => extractPptx(zip)).toThrow(ZipLimitError)
  })
})

describe('unicode and entities', () => {
  it('preserves non-latin text and typographic punctuation', () => {
    const xml = slideXml(textShape('光合作用', 'Ωmega — “quoted”', 'Ångström ±0.5 °C'))
    expect(extractSlideContent(xml).text).toBe('光合作用\nΩmega — “quoted”\nÅngström ±0.5 °C')
  })

  it('decodes entities exactly once', () => {
    // "&amp;lt;" is the literal text "&lt;". Decoding twice would turn it into "<" and
    // invent markup the slide never contained.
    expect(decodeEntities('&amp;lt;')).toBe('&lt;')
    expect(decodeEntities('a &amp; b &lt;tag&gt;')).toBe('a & b <tag>')
    expect(decodeEntities('&#8212;&#x2014;')).toBe('——')
  })

  it('leaves an unknown or malformed entity alone', () => {
    expect(decodeEntities('&nosuch; &#xZZ; 100% &')).toBe('&nosuch; &#xZZ; 100% &')
  })

  it('carries entity-encoded slide text through extraction', () => {
    const xml = slideXml(textShape('Rock &amp; Roll', '5 &lt; 10'))
    expect(extractSlideContent(xml).text).toBe('Rock & Roll\n5 < 10')
  })
})

describe('xml scanner', () => {
  it('does not end a tag at a > inside a quoted attribute', () => {
    const tokens = [...scanXml('<a:t title="a > b">text</a:t>')]
    const open = tokens.find((t) => 'name' in t && t.kind === 'open')
    expect(open && 'raw' in open && attr(open.raw, 'title')).toBe('a > b')
    expect(tokens.some((t) => t.kind === 'text' && t.value === 'text')).toBe(true)
  })

  it('skips comments, doctypes and processing instructions', () => {
    const xml = '<?xml version="1.0"?><!-- <a:t>hidden</a:t> --><p:sp><p:txBody><a:p><a:r><a:t>real</a:t></a:r></a:p></p:txBody></p:sp>'
    expect(extractSlideContent(xml).text).toBe('real')
  })

  it('tolerates unbalanced markup instead of throwing', () => {
    expect(() => extractSlideContent('<a:p><a:r><a:t>dangling')).not.toThrow()
    expect(() => extractSlideContent('</a:t></a:p>')).not.toThrow()
  })
})
