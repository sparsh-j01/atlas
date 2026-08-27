import { describe, expect, it } from 'vitest'
import { assertSameSource, gradeQueries, resolveEvidence, type GradedResult } from './grade'
import { PRODUCTION_TOP_K } from './metrics'
import { GOLDEN_QUERIES } from '../documents/golden-queries'
import { CORPUS_DOCUMENTS, corpusFullText } from '../documents/openstax-corpus'
import { chunkDocument, type IdentifiedSection } from '@/lib/ai/chunk'

// The grading loop, driven by a STUB retriever over the real corpus and the real chunker.
//
// `npm run eval` itself needs a seeded document, a database and an API key, so nothing here
// could run in CI — which is how the previous harness reached two milestones without ever
// having executed. Substituting the retriever is enough: everything the eval decides
// (rank, coverage, abstention routing, source-drift detection) is in this function, and the
// only thing the stub removes is the network.

const doc = CORPUS_DOCUMENTS[0]
const fullText = corpusFullText(doc)
const queries = GOLDEN_QUERIES.filter((q) => q.documentId === doc.id)

function sectionsOf(): IdentifiedSection[] {
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

const chunks = await chunkDocument(fullText, sectionsOf())
const asResult = (i: number, similarity: number | null = 0.7): GradedResult => ({
  chunkId: `c${i}`,
  text: chunks[i].text,
  similarity,
  source: { charStart: chunks[i].charStart, charEnd: chunks[i].charEnd },
})

/** Retriever that returns the chunks a caller names, in the order it names them. */
function stub(pick: (query: string) => number[], similarity: number | null = 0.7) {
  return { retrieve: async (query: string) => pick(query).map((i) => asResult(i, similarity)) }
}

/** Chunk indices a query's evidence actually lives in, computed from the real chunking. */
function goldIndicesOf(queryId: string): number[] {
  const ev = resolveEvidence(fullText, queries).get(queryId)!
  return chunks.flatMap((c, i) => (ev.some((e) => c.charStart < e.charEnd && e.charStart < c.charEnd) ? [i] : []))
}

/** A query whose evidence really does land in more than one chunk. Not every `contextual`
 *  query does — that category only requires 2+ sentences, which often sit in one chunk —
 *  so the split is looked up from the real chunking rather than assumed from the label. */
const splitQuery = queries.find((q) => q.evidenceSpans.length > 0 && goldIndicesOf(q.id).length > 1)!

const opts = { topK: 10, label: doc.id, isRelevant: (r: GradedResult[]) => r.some((x) => (x.similarity ?? 0) >= 0.5) }

describe('gradeQueries', () => {
  it('ranks a gold chunk by where it appears in the retrieved list', async () => {
    const q = queries.find((x) => x.category === 'direct_fact')!
    const gold = goldIndicesOf(q.id)[0]
    const filler = chunks.map((_, i) => i).filter((i) => !goldIndicesOf(q.id).includes(i))
    const run = await gradeQueries(stub(() => [filler[0], filler[1], gold]), [q], fullText, opts)
    expect(run.graded[0].rank).toBe(3)
    expect(run.graded[0].query.id).toBe(q.id)
  })

  it('scores a miss as rank 0 rather than dropping the query', async () => {
    const q = queries.find((x) => x.category === 'direct_fact')!
    const filler = chunks.map((_, i) => i).filter((i) => !goldIndicesOf(q.id).includes(i))
    const run = await gradeQueries(stub(() => filler.slice(0, 5)), [q], fullText, opts)
    expect(run.graded).toHaveLength(1)
    expect(run.graded[0].rank).toBe(0)
  })

  it('separates finding SOME evidence from having ALL of it', async () => {
    // Evidence spread over two chunks. Return only the first: it is a hit at rank 1, and
    // still not answerable. Substring grading cannot express the difference.
    const q = splitQuery
    const gold = goldIndicesOf(q.id)
    const partial = await gradeQueries(stub(() => [gold[0]]), [q], fullText, opts)
    expect(partial.graded[0].rank).toBe(1)
    expect(partial.graded[0].covered).toBe(false)

    const complete = await gradeQueries(stub(() => gold), [q], fullText, opts)
    expect(complete.graded[0].covered).toBe(true)
  })

  it('judges coverage at the production K, not at the reporting K', async () => {
    // Evidence that arrives at rank 9 is inside recall@10 and outside what generation sees.
    const q = splitQuery
    const gold = goldIndicesOf(q.id)
    const filler = chunks.map((_, i) => i).filter((i) => !gold.includes(i))
    const late = [...filler.slice(0, PRODUCTION_TOP_K), ...gold]
    const run = await gradeQueries(stub(() => late), [q], fullText, opts)
    expect(run.graded[0].rank).toBe(PRODUCTION_TOP_K + 1)
    expect(run.graded[0].covered).toBe(false)
  })

  it('routes unanswerable queries to the abstention tally, not to recall', async () => {
    const q = queries.find((x) => x.category === 'unanswerable')!
    const confident = await gradeQueries(stub(() => [0, 1], 0.9), [q], fullText, opts)
    expect(confident.graded).toHaveLength(0)
    expect(confident.negatives).toEqual([{ abstained: false }])

    const floored = await gradeQueries(stub(() => [0, 1], 0.2), [q], fullText, opts)
    expect(floored.negatives).toEqual([{ abstained: true }])
  })

  it('keeps similarity null when the arm produces none, instead of reading it as 0', async () => {
    const q = queries.find((x) => x.category === 'direct_fact')!
    const run = await gradeQueries(stub(() => goldIndicesOf(q.id), null), [q], fullText, opts)
    expect(run.graded[0].topSimilarity).toBeNull()
  })

  it('refuses to grade a document whose coordinates are not this corpus', async () => {
    // The failure this exists to catch: a re-ingest that shifted every offset. Grading would
    // otherwise report a plausible low score and send someone off tuning the retriever.
    const shifted = { retrieve: async () => [{ ...asResult(3), source: { charStart: 0, charEnd: 40 } }] }
    await expect(gradeQueries(shifted, queries.slice(0, 1), fullText, opts)).rejects.toThrow(/not the pinned text/)
  })

  it('grades the whole document set end to end with a perfect-oracle retriever', async () => {
    // Smoke test over all 50 queries: every gradable one must be scoreable against the real
    // chunking. A query whose evidence lands in no chunk would score 0 forever and look like
    // a retrieval bug, which is exactly what boundary-crossing evidence did under the old
    // grader.
    const run = await gradeQueries(
      stub((query) => {
        const q = queries.find((x) => x.query === query)!
        return q.evidenceSpans.length === 0 ? [0] : goldIndicesOf(q.id)
      }),
      queries,
      fullText,
      opts,
    )
    expect(run.graded.length + run.negatives.length).toBe(queries.length)
    expect(run.graded.every((o) => o.rank === 1), 'a gold chunk was unreachable').toBe(true)
    expect(run.graded.every((o) => o.covered)).toBe(true)
  })
})

describe('resolveEvidence', () => {
  it('rejects a span that is not in the source', () => {
    expect(() => resolveEvidence(fullText, [{ ...queries[0], evidenceSpans: ['not in this document'] }])).toThrow(
      /Golden dataset is broken/,
    )
  })

  it('skips queries with no evidence rather than recording an empty interval list', () => {
    const map = resolveEvidence(fullText, queries)
    for (const q of queries) expect(map.has(q.id)).toBe(q.evidenceSpans.length > 0)
  })
})

describe('assertSameSource', () => {
  it('passes when every chunk slices back to its own text', () => {
    expect(() => assertSameSource(fullText, chunks.map((_, i) => asResult(i)), doc.id)).not.toThrow()
  })

  it('names the offending chunk', () => {
    const bad = [asResult(0), { ...asResult(1), source: { charStart: 5, charEnd: 9 } }]
    expect(() => assertSameSource(fullText, bad, doc.id)).toThrow(/chunk c1 at \[5, 9\)/)
  })
})
