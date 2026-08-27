import { describe, it, expect } from 'vitest'
import { chunkDocument, estimateTokens, MAX_TOKENS } from '../chunk'
import type { IdentifiedSection } from '../chunk'

// The load-bearing test in this file is `slice(charStart, charEnd) === text`.
// Everything else is secondary. The previous chunker passed five tests that asserted
// charStart/charEnd merely EXISTED, while emitting spans that pointed at a different
// copy of a repeated paragraph.

const section = (
  over: Partial<IdentifiedSection> & { startOffset: number; endOffset: number },
): IdentifiedSection => ({
  id: 'sec-1',
  heading: 'S',
  pageStart: 1,
  pageEnd: 1,
  ...over,
})
const whole = (text: string) => [section({ startOffset: 0, endOffset: text.length })]

/** Asserts the one invariant the rest of the RAG path depends on. */
function expectSliceExact(fullText: string, chunks: Awaited<ReturnType<typeof chunkDocument>>) {
  for (const c of chunks) {
    expect(fullText.slice(c.charStart, c.charEnd)).toBe(c.text)
  }
}

describe('estimateTokens', () => {
  it('estimates roughly chars/4', () => {
    expect(estimateTokens('a'.repeat(400))).toBe(100)
    expect(estimateTokens('')).toBe(0)
  })
})

describe('chunkDocument provenance', () => {
  it('records spans that slice back to the chunk text', async () => {
    const text = 'Alpha paragraph here.\n\nBeta paragraph here.\n\nGamma paragraph here.'
    const chunks = await chunkDocument(text, whole(text))
    expectSliceExact(text, chunks)
  })

  it('cites the right copy when a paragraph is repeated', async () => {
    // The bug this test exists for: indexOf() returned the FIRST occurrence, so the
    // second copy was cited at the first copy's offsets.
    const filler = (t: string) => `Paragraph ${t}. ` + 'lorem ipsum dolor sit amet consectetur. '.repeat(20)
    const dup = 'Shared boilerplate paragraph that appears twice. '.repeat(10)
    const text = [filler('one'), dup, filler('three'), filler('four'), dup].join('\n\n')
    const chunks = await chunkDocument(text, whole(text))

    expect(chunks.length).toBeGreaterThan(1)
    expectSliceExact(text, chunks)
  })

  it('keeps spans ordered and forward-moving', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i}. ` + 'filler words here. '.repeat(30)).join('\n\n')
    const chunks = await chunkDocument(text, whole(text))

    expect(chunks.length).toBeGreaterThan(1)
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].charStart).toBeGreaterThanOrEqual(chunks[i - 1].charStart)
      expect(chunks[i].charEnd).toBeGreaterThan(chunks[i - 1].charEnd)
    }
  })

  it('leaves no section text uncited', async () => {
    const text = Array.from({ length: 8 }, (_, i) => `Para ${i}. ` + 'some content to pad it out. '.repeat(25)).join('\n\n')
    const chunks = await chunkDocument(text, whole(text))

    // Every non-whitespace character of the section falls inside some chunk span.
    const covered = new Array(text.length).fill(false)
    for (const c of chunks) for (let i = c.charStart; i < c.charEnd; i++) covered[i] = true
    const missed = [...text].filter((ch, i) => !covered[i] && !/\s/.test(ch)).length
    expect(missed).toBe(0)
  })

  it('splits an oversized paragraph on sentences with correct spans', async () => {
    const sentence = (n: number) => `Sentence number ${n} carries a distinct fact and some filler words to add length. `
    const text = Array.from({ length: 40 }, (_, i) => sentence(i)).join('')
    const chunks = await chunkDocument(text, whole(text))

    expect(chunks.length).toBeGreaterThan(1)
    expectSliceExact(text, chunks)
  })

  it('hard-splits a single sentence with no terminator', async () => {
    const text = 'x'.repeat(MAX_TOKENS * 4 * 3) // no sentence or paragraph boundary anywhere
    const chunks = await chunkDocument(text, whole(text))

    expect(chunks.length).toBe(3)
    expectSliceExact(text, chunks)
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(MAX_TOKENS)
  })
})

describe('chunkDocument boundaries', () => {
  it('respects the token cap', async () => {
    const text = Array.from({ length: 20 }, (_, i) => `Para ${i}. ` + 'word '.repeat(100)).join('\n\n')
    const chunks = await chunkDocument(text, whole(text))
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(MAX_TOKENS)
  })

  it('never merges across a section boundary', async () => {
    const a = 'Section A content.'
    const b = 'Section B content.'
    const text = `${a}\n\n${b}`
    const sections = [
      section({ id: 'id-a', heading: 'A', startOffset: 0, endOffset: a.length }),
      section({ id: 'id-b', heading: 'B', pageStart: 2, pageEnd: 2, startOffset: text.indexOf(b), endOffset: text.length }),
    ]
    const chunks = await chunkDocument(text, sections)

    expect(chunks.map((c) => c.sectionId)).toEqual(['id-a', 'id-b'])
    expect(chunks[0].text).toBe(a)
    expect(chunks[1].text).toBe(b)
    expectSliceExact(text, chunks)
  })

  it('carries section provenance onto every chunk', async () => {
    const text = 'Content here.'
    const [chunk] = await chunkDocument(text, [section({ startOffset: 0, endOffset: text.length, pageStart: 4, pageEnd: 7 })])
    expect(chunk).toMatchObject({ sectionId: 'sec-1', pageStart: 4, pageEnd: 7, charStart: 0 })
    expect(chunk.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('clamps out-of-range model offsets', async () => {
    const text = 'Short doc.'
    // A model can return offsets past the end of the document; they must not produce
    // a chunk whose span lies outside the source.
    const chunks = await chunkDocument(text, [
      section({ startOffset: 0, endOffset: 999_999 }),
      // An inverted or empty range yields no chunk rather than a negative-length slice.
      section({ id: 'empty', startOffset: 5, endOffset: 5 }),
    ])
    expect(chunks).toHaveLength(1)
    expect(chunks[0].charEnd).toBeLessThanOrEqual(text.length)
    expectSliceExact(text, chunks)
  })

  it('produces overlapping spans only when overlap is requested', async () => {
    const text = Array.from({ length: 10 }, (_, i) => `Para ${i}. ` + 'word '.repeat(120)).join('\n\n')
    const none = await chunkDocument(text, whole(text))
    const lapped = await chunkDocument(text, whole(text), { overlapTokens: 50 })

    expect(none.length).toBeGreaterThan(1)
    for (let i = 1; i < none.length; i++) expect(none[i].charStart).toBeGreaterThanOrEqual(none[i - 1].charEnd)
    expect(lapped.some((c, i) => i > 0 && c.charStart < lapped[i - 1].charEnd)).toBe(true)
    expectSliceExact(text, lapped)
  })

  it('keeps two sections with the SAME heading apart', async () => {
    // Sections used to be looked up by heading, so a document with two "Introduction"
    // sections filed every chunk of the second under the first section's id.
    const a = 'First introduction body.'
    const b = 'Second introduction body.'
    const text = `${a}\n\n${b}`
    const chunks = await chunkDocument(text, [
      section({ id: 'first', heading: 'Introduction', startOffset: 0, endOffset: a.length }),
      section({ id: 'second', heading: 'Introduction', startOffset: text.indexOf(b), endOffset: text.length }),
    ])

    expect(chunks.map((c) => c.sectionId)).toEqual(['first', 'second'])
  })
})
