import { describe, expect, it } from 'vitest'
import { buildSections, chunkRowId, EVAL_OWNER_ID, evalDocumentId, stableUuid } from './seed-ids'
import { CORPUS_DOCUMENTS, corpusFullText } from './documents/openstax-corpus'
import { chunkDocument } from '@/lib/ai/chunk'

// The seeder decides where every row lands. `seed.ts` itself talks to a database and to
// Gemini, so these cover the half that can be wrong without either: id derivation and the
// pinned section offsets. Both are load-bearing — an id that is not stable breaks
// idempotency silently, and an offset that is off by one silently misgrades every query.

describe('stableUuid', () => {
  it('is deterministic and well-formed', () => {
    const a = stableUuid('hello')
    expect(a).toBe(stableUuid('hello'))
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('separates different names', () => {
    expect(stableUuid('a')).not.toBe(stableUuid('b'))
  })

  it('gives every corpus document its own id, stable across calls', () => {
    const ids = CORPUS_DOCUMENTS.map((d) => evalDocumentId(d.id))
    expect(new Set(ids).size).toBe(CORPUS_DOCUMENTS.length)
    expect(ids).toEqual(CORPUS_DOCUMENTS.map((d) => evalDocumentId(d.id)))
    expect(ids).not.toContain(EVAL_OWNER_ID)
  })

  it('changes a chunk id when its content changes', () => {
    // What makes re-seeding safe: edited text lands under a new id, so the old row and its
    // embedding cascade away rather than the vector outliving the prose it described.
    const doc = evalDocumentId(CORPUS_DOCUMENTS[0].id)
    expect(chunkRowId(doc, 0, 'hash-a')).not.toBe(chunkRowId(doc, 0, 'hash-b'))
    expect(chunkRowId(doc, 0, 'hash-a')).toBe(chunkRowId(doc, 0, 'hash-a'))
  })
})

describe('buildSections', () => {
  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'every section offset in %s slices back to its own page',
    (docId) => {
      // The +2 for '\n\n' is the whole game. One character of drift here and gold evidence
      // — recorded as offsets into this exact string — points at neighbouring prose.
      const doc = CORPUS_DOCUMENTS.find((d) => d.id === docId)!
      const full = corpusFullText(doc)
      const sections = buildSections(doc)
      expect(sections).toHaveLength(doc.pages.length)
      sections.forEach((s, i) => {
        expect(full.slice(s.startOffset, s.endOffset), `${docId} section ${i}`).toBe(doc.pages[i])
        expect(s.heading).toBe(doc.sectionTitles[i])
      })
      expect(sections.at(-1)!.endOffset).toBe(full.length)
    },
  )

  it('gives every section across the whole corpus a distinct id', () => {
    const ids = CORPUS_DOCUMENTS.flatMap((d) => buildSections(d).map((s) => s.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each([
    ['openstax-social-psychology', 67],
    ['openstax-big-bang', 70],
    ['openstax-patent-enforcement', 64],
  ])('chunks %s into the %i chunks the corpus gates were measured against', async (docId, expected) => {
    // Ties the SEEDER's section construction to the corpus the invariants were validated
    // on. If the seeder built sections even slightly differently from the corpus tests, the
    // database would hold a different chunking than every gate that was signed off, and the
    // benchmark would be measuring a corpus nobody checked.
    const doc = CORPUS_DOCUMENTS.find((d) => d.id === docId)!
    const chunks = await chunkDocument(corpusFullText(doc), buildSections(doc))
    expect(chunks).toHaveLength(expected)
  })
})
