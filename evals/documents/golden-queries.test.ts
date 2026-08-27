import { describe, expect, it } from 'vitest'
import { GOLDEN_QUERIES, type GoldenQuery } from './golden-queries'
import { CORPUS_DOCUMENTS, corpusFullText } from './openstax-corpus'
import { chunksSpanned, spanToInterval, verifyInterval, type GoldInterval } from '../retrieval/evidence'
import { chunkDocument, type ChunkResult, type IdentifiedSection } from '@/lib/ai/chunk'
import { createBM25Index } from '@/lib/ai/bm25'

// The construction invariants from the master doc, enforced rather than described.
//
// Every one of these corresponds to a defect measured in the v0 golden set. v0 would fail
// six of them: it reused an expected span across two queries, put four of six queries on
// one chunk, had a "semantic_paraphrase" query that BM25 ranked #1, had zero
// boundary-crossing evidence, had one out-of-domain unanswerable, and had no distractors.

const DOC_IDS = new Set(CORPUS_DOCUMENTS.map((d) => d.id))

function sectionsOf(doc: (typeof CORPUS_DOCUMENTS)[number]): IdentifiedSection[] {
  let off = 0
  return doc.pages.map((p, i) => {
    const s = {
      id: `${doc.id}-sec-${i}`, heading: doc.sectionTitles[i] ?? `S${i}`,
      pageStart: i + 1, pageEnd: i + 1, startOffset: off, endOffset: off + p.length,
    }
    off += p.length + 2
    return s
  })
}

/** Chunks + BM25 index per document, built once. */
const built = new Map<string, { full: string; chunks: ChunkResult[]; bm25: ReturnType<typeof createBM25Index> }>()
async function build(docId: string) {
  const cached = built.get(docId)
  if (cached) return cached
  const doc = CORPUS_DOCUMENTS.find((d) => d.id === docId)!
  const full = corpusFullText(doc)
  const chunks = await chunkDocument(full, sectionsOf(doc))
  const bm25 = createBM25Index(chunks.map((c, i) => ({ id: String(i), text: c.text, tokenCount: c.tokenCount })))
  const v = { full, chunks, bm25 }
  built.set(docId, v)
  return v
}

function intervalsOf(full: string, q: GoldenQuery): GoldInterval[] {
  return q.evidenceSpans.map((span) => {
    const r = spanToInterval(full, span)
    if (!r.ok) throw new Error(`${q.id}: ${r.error}`)
    return r.value
  })
}

/** Chunk indices a query's evidence lands in. */
function goldChunks(chunks: ChunkResult[], intervals: GoldInterval[]): number[] {
  const hit = new Set<number>()
  chunks.forEach((c, i) => {
    if (intervals.some((ev) => c.charStart < ev.charEnd && ev.charStart < c.charEnd)) hit.add(i)
  })
  return [...hit]
}

const gradable = GOLDEN_QUERIES.filter((q) => q.evidenceSpans.length > 0)
const negative = GOLDEN_QUERIES.filter((q) => q.evidenceSpans.length === 0)

describe('dataset shape', () => {
  it('has unique query ids', () => {
    const ids = GOLDEN_QUERIES.map((q) => q.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('references only documents that exist in the corpus', () => {
    for (const q of GOLDEN_QUERIES) expect(DOC_IDS.has(q.documentId), q.id).toBe(true)
  })

  it('marks every unanswerable query with empty evidence, and nothing else', () => {
    for (const q of GOLDEN_QUERIES) {
      expect(q.evidenceSpans.length === 0, q.id).toBe(q.category === 'unanswerable')
    }
  })

  it('gives every keyword_heavy query a keyTerm to check', () => {
    for (const q of GOLDEN_QUERIES) {
      if (q.category === 'keyword_heavy') expect(q.keyTerm, q.id).toBeTruthy()
    }
  })

  it('holds the target distribution: 40 gradable + 10 negative, per category', () => {
    // Master doc section 5.6. Asserted rather than eyeballed because the distribution is
    // what makes the aggregate numbers interpretable: drop the paraphrase queries and a
    // lexical retriever scores beautifully on a dataset that no longer tests it.
    expect({ gradable: gradable.length, negative: negative.length }).toEqual({ gradable: 40, negative: 10 })
    const counts = new Map<string, number>()
    for (const q of GOLDEN_QUERIES) counts.set(q.category, (counts.get(q.category) ?? 0) + 1)
    expect(Object.fromEntries([...counts].sort())).toEqual({
      boundary: 5,
      contextual: 6,
      direct_fact: 8,
      distractor: 5,
      keyword_heavy: 8,
      semantic_paraphrase: 8,
      unanswerable: 10,
    })
  })

  it('spreads the queries across all three corpus documents', () => {
    // One document carrying most of the set would make the whole benchmark a measurement of
    // that document's prose register. Register diversity is why there are three.
    for (const doc of CORPUS_DOCUMENTS) {
      const n = GOLDEN_QUERIES.filter((q) => q.documentId === doc.id).length
      expect(n, doc.id).toBeGreaterThanOrEqual(12)
    }
  })
})

describe('evidence integrity', () => {
  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'every span in %s is present exactly once and slices back to itself',
    async (docId) => {
      const { full } = await build(docId)
      for (const q of gradable.filter((x) => x.documentId === docId)) {
        for (const span of q.evidenceSpans) {
          const r = spanToInterval(full, span)
          // Ambiguous spans are rejected, not resolved to the first occurrence: silently
          // grading the wrong copy is how substring matching went wrong.
          expect(r.ok ? '' : r.error, q.id).toBe('')
          if (r.ok) expect(verifyInterval(full, r.value), q.id).toEqual({ ok: true })
        }
      }
    },
  )
})

describe('construction invariants', () => {
  it('invariant 1: no evidence span is reused across queries', () => {
    // v0 gave q1 and q4 the identical expectedSpan.
    const seen = new Map<string, string>()
    for (const q of gradable) {
      for (const span of q.evidenceSpans) {
        const key = `${q.documentId}::${span}`
        expect(seen.get(key) ?? q.id, `${q.id} reuses the span from ${seen.get(key)}`).toBe(q.id)
        seen.set(key, q.id)
      }
    }
  })

  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'invariant 2: in %s no chunk is the gold target for more than 2 queries',
    async (docId) => {
      // v0 put 4 of 6 queries on one chunk, so "always return chunk 0" scored 0.667 MRR.
      const { full, chunks } = await build(docId)
      const count = new Map<number, string[]>()
      for (const q of gradable.filter((x) => x.documentId === docId)) {
        for (const i of goldChunks(chunks, intervalsOf(full, q))) {
          count.set(i, [...(count.get(i) ?? []), q.id])
        }
      }
      for (const [chunkIndex, ids] of count) {
        expect(ids.length, `chunk ${chunkIndex} is gold for ${ids.join(', ')}`).toBeLessThanOrEqual(2)
      }
    },
  )

  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'invariant 3: every semantic_paraphrase query in %s is NOT won by BM25 alone',
    async (docId) => {
      // The check v0's single paraphrase query failed. If a lexical ranker puts the gold
      // chunk first, the query is not testing semantic retrieval.
      const { full, chunks, bm25 } = await build(docId)
      for (const q of gradable.filter((x) => x.documentId === docId && x.category === 'semantic_paraphrase')) {
        const gold = new Set(goldChunks(chunks, intervalsOf(full, q)).map(String))
        const top = bm25.search(q.query, 1)[0]
        expect(top ? gold.has(top.documentId) : false, `${q.id}: BM25 ranked gold chunk first`).toBe(false)
      }
    },
  )

  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'invariant 4: every keyword_heavy key term in %s has document frequency 1',
    async (docId) => {
      const { chunks } = await build(docId)
      for (const q of gradable.filter((x) => x.documentId === docId && x.category === 'keyword_heavy')) {
        const term = q.keyTerm!.toLowerCase()
        const df = chunks.filter((c) => c.text.toLowerCase().includes(term)).length
        expect(df, `${q.id}: "${q.keyTerm}" appears in ${df} chunks`).toBe(1)
      }
    },
  )

  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'invariant 5: every boundary query in %s has evidence spanning 2+ chunks',
    async (docId) => {
      const { full, chunks } = await build(docId)
      for (const q of gradable.filter((x) => x.documentId === docId && x.category === 'boundary')) {
        for (const ev of intervalsOf(full, q)) {
          expect(chunksSpanned(chunks, ev), `${q.id}`).toBeGreaterThanOrEqual(2)
        }
      }
    },
  )

  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'invariant 7: every distractor query in %s is LOST by BM25 alone',
    async (docId) => {
      // The point of the category: a lexically similar wrong chunk must outrank the right
      // one, or nothing detects surface-term pattern matching.
      const { full, chunks, bm25 } = await build(docId)
      for (const q of gradable.filter((x) => x.documentId === docId && x.category === 'distractor')) {
        const gold = new Set(goldChunks(chunks, intervalsOf(full, q)).map(String))
        const top = bm25.search(q.query, 1)[0]
        expect(top ? gold.has(top.documentId) : true, `${q.id}: BM25 ranked the gold chunk first, so it is not a distractor`).toBe(false)
      }
    },
  )

  it('contextual queries require more than one interval', () => {
    for (const q of gradable.filter((x) => x.category === 'contextual')) {
      expect(q.evidenceSpans.length, q.id).toBeGreaterThanOrEqual(2)
    }
  })

  it.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))(
    'invariant 8: %s has a contextual query whose intervals land in DIFFERENT chunks',
    async (docId) => {
      // MEASURED DEFECT, not a hypothetical. Every contextual query as first written had
      // both of its required intervals inside a single chunk, so retrieving that one chunk
      // satisfied all of them: all-evidence recall was arithmetically identical to
      // any-evidence recall on all 40 gradable queries, and the metric multi-interval
      // evidence exists to unlock could not vary. Two intervals is not the invariant —
      // two intervals in two chunks is.
      const { full, chunks } = await build(docId)
      const split = gradable
        .filter((q) => q.documentId === docId && q.category === 'contextual')
        .filter((q) => {
          const sets = intervalsOf(full, q).map((ev) => goldChunks(chunks, [ev]).join(','))
          return new Set(sets).size > 1
        })
      expect(split.length, `${docId} has no cross-chunk contextual query`).toBeGreaterThanOrEqual(1)
    },
  )
})

describe('negative queries', () => {
  it('are in-domain: their terms occur in the document they are asked against', async () => {
    // v0 asked about aquarium pH against a biology chapter. The cosine floor rejects that
    // trivially, so it measured the embedder, not the calibration of the floor.
    for (const q of negative) {
      const { full } = await build(q.documentId)
      const haystack = full.toLowerCase()
      const content = q.query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 4)
      const overlap = content.filter((w) => haystack.includes(w))
      expect(
        overlap.length,
        `${q.id} shares no vocabulary with its document, so it is out-of-domain: ${q.query}`,
      ).toBeGreaterThanOrEqual(2)
    }
  })

  it('are genuinely unanswerable: no query is just a rephrased gradable query', () => {
    const gradableQueries = new Set(gradable.map((q) => q.query.toLowerCase()))
    for (const q of negative) expect(gradableQueries.has(q.query.toLowerCase())).toBe(false)
  })
})
