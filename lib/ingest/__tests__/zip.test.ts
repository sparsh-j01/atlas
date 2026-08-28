import { describe, expect, it } from 'vitest'
import {
  MAX_ENTRIES,
  MAX_INFLATED_BYTES,
  ZipLimitError,
  declaredUncompressedTotal,
  isAllowedPptxPath,
  listEntryNames,
  readZipEntries,
} from '../zip'
import { buildZip } from './zip-fixtures'

const text = (b: Uint8Array) => new TextDecoder().decode(b)

describe('isAllowedPptxPath', () => {
  it('accepts the paths a pptx is actually read from', () => {
    expect(isAllowedPptxPath('ppt/slides/slide1.xml')).toBe(true)
    expect(isAllowedPptxPath('ppt/slides/_rels/slide1.xml.rels')).toBe(true)
    expect(isAllowedPptxPath('ppt/notesSlides/notesSlide1.xml')).toBe(true)
    expect(isAllowedPptxPath('ppt/media/image1.png')).toBe(true)
  })

  it('rejects everything outside those prefixes', () => {
    expect(isAllowedPptxPath('docProps/app.xml')).toBe(false)
    expect(isAllowedPptxPath('[Content_Types].xml')).toBe(false)
    expect(isAllowedPptxPath('ppt/embeddings/oleObject1.bin')).toBe(false)
    expect(isAllowedPptxPath('ppt/theme/theme1.xml')).toBe(false)
  })

  it('matches on prefix, not substring — a nested lookalike is not a match', () => {
    // The bug this guards: `includes('ppt/media/')` would accept every one of these.
    expect(isAllowedPptxPath('evil/ppt/media/payload.png')).toBe(false)
    expect(isAllowedPptxPath('x/ppt/slides/slide1.xml')).toBe(false)
    expect(isAllowedPptxPath('../ppt/media/image1.png')).toBe(false)
  })

  it('rejects traversal, absolute and backslash paths outright', () => {
    expect(isAllowedPptxPath('ppt/media/../../../etc/passwd')).toBe(false)
    expect(isAllowedPptxPath('/ppt/media/image1.png')).toBe(false)
    expect(isAllowedPptxPath('ppt\\media\\image1.png')).toBe(false)
    expect(isAllowedPptxPath('ppt/slides/..%2f..%2fetc')).toBe(false)
  })
})

describe('readZipEntries', () => {
  it('inflates only the allowed entries and leaves the rest untouched', () => {
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: 'SLIDE ONE' },
      { path: 'docProps/app.xml', data: 'METADATA' },
      { path: 'ppt/media/image1.png', data: 'PNGBYTES' },
      { path: '[Content_Types].xml', data: 'TYPES' },
    ])
    const entries = readZipEntries(zip)
    expect(entries.map((e) => e.path)).toEqual(['ppt/slides/slide1.xml', 'ppt/media/image1.png'])
    expect(text(entries[0].bytes)).toBe('SLIDE ONE')
  })

  it('reads stored (uncompressed) entries as well as deflated ones', () => {
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: 'STORED', method: 0 },
      { path: 'ppt/slides/slide2.xml', data: 'DEFLATED', method: 8 },
    ])
    const entries = readZipEntries(zip)
    expect(entries.map((e) => text(e.bytes))).toEqual(['STORED', 'DEFLATED'])
  })

  it('round-trips unicode content and unicode entry names', () => {
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: 'Ω≈ç√ 中文 — “quotes”' }])
    expect(text(readZipEntries(zip)[0].bytes)).toBe('Ω≈ç√ 中文 — “quotes”')
  })

  it('returns nothing rather than throwing when no entry is allowed', () => {
    const zip = buildZip([{ path: 'docProps/app.xml', data: 'x' }])
    expect(readZipEntries(zip)).toEqual([])
  })

  it('survives a non-zip buffer without throwing', () => {
    expect(readZipEntries(new TextEncoder().encode('%PDF-1.7 not a zip'))).toEqual([])
    expect(readZipEntries(new Uint8Array(0))).toEqual([])
  })
})

describe('decompression limits', () => {
  it('refuses an archive with too many entries, before inflating any of them', () => {
    const files = Array.from({ length: 5 }, (_, i) => ({ path: `ppt/slides/slide${i}.xml`, data: 'x' }))
    expect(() => readZipEntries(buildZip(files), { maxEntries: 4 })).toThrow(ZipLimitError)
  })

  it('refuses an archive whose declared uncompressed total is over the cap', () => {
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: 'x', declaredSize: 999_999 }])
    expect(() => readZipEntries(zip, { maxInflated: 1000 })).toThrow(/declares 999999/)
  })

  it('stops a bomb that UNDER-declares its size in the central directory', () => {
    // The whole reason the running counter exists: the directory says 10 bytes, the entry
    // actually inflates to 1MB. Both cheap pre-checks pass. zlib's maxOutputLength does not.
    const payload = new Uint8Array(1024 * 1024) // a megabyte of zeroes, ~1000:1 deflate
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: payload, declaredSize: 10 }])
    expect(zip.length).toBeLessThan(5000)
    expect(() => readZipEntries(zip, { maxInflated: 4096 })).toThrow(ZipLimitError)
  })

  it('bounds the TOTAL across entries, not each one separately', () => {
    // Four entries of 300 bytes each pass any per-entry check of 500 and still exceed 1000.
    const files = Array.from({ length: 4 }, (_, i) => ({
      path: `ppt/slides/slide${i}.xml`,
      data: 'a'.repeat(300),
    }))
    expect(() => readZipEntries(buildZip(files), { maxInflated: 1000 })).toThrow(ZipLimitError)
  })

  it('accepts an archive that sits just under the cap', () => {
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: 'a'.repeat(100) }])
    expect(readZipEntries(zip, { maxInflated: 100 })).toHaveLength(1)
  })

  it('ships with limits that admit a real presentation and reject a bomb', () => {
    expect(MAX_INFLATED_BYTES).toBe(200 * 1024 * 1024)
    expect(MAX_ENTRIES).toBe(2_000)
  })
})

describe('duplicate entry names', () => {
  it('refuses an archive that names the same entry twice', () => {
    // A parser differential, not a corrupt file: some readers take the first entry, some
    // the last, so the archive's contents depend on who opens it.
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: 'FIRST' },
      { path: 'ppt/slides/slide1.xml', data: 'SECOND' },
    ])
    expect(() => readZipEntries(zip)).toThrow(/more than once/)
  })

  it('refuses even when the duplicate is a media part', () => {
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: 'x' },
      { path: 'ppt/media/image1.png', data: 'A' },
      { path: 'ppt/media/image1.png', data: 'B' },
    ])
    expect(() => readZipEntries(zip)).toThrow(/more than once/)
  })

  it('refuses a duplicate the prefix filter would have skipped', () => {
    // Checked across the whole central directory, before filtering: a reader that opens the
    // other copy is still reading a different archive from this one.
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: 'x' },
      { path: 'docProps/app.xml', data: 'A' },
      { path: 'docProps/app.xml', data: 'B' },
    ])
    expect(() => readZipEntries(zip)).toThrow(/more than once/)
  })

  it('allows distinct names that differ only by case', () => {
    // Zip names are case-sensitive; these are two entries, not one written twice.
    const zip = buildZip([
      { path: 'ppt/media/Image1.png', data: 'A' },
      { path: 'ppt/media/image1.png', data: 'B' },
    ])
    expect(readZipEntries(zip)).toHaveLength(2)
  })
})

describe('central directory reading', () => {
  it('lists names without inflating', () => {
    const zip = buildZip([
      { path: 'ppt/slides/slide1.xml', data: 'a' },
      { path: 'docProps/app.xml', data: 'b' },
    ])
    expect(listEntryNames(zip)).toEqual(['ppt/slides/slide1.xml', 'docProps/app.xml'])
  })

  it('reports the declared total, including a dishonest one', () => {
    const zip = buildZip([{ path: 'ppt/slides/slide1.xml', data: 'abc', declaredSize: 77 }])
    expect(declaredUncompressedTotal(zip)).toBe(77)
  })
})
