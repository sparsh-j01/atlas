import { describe, it, expect } from 'vitest'
import { createBM25Index, type BM25Document } from '../bm25'

const doc = (id: string, text: string): BM25Document => ({
  id,
  text,
  tokenCount: Math.ceil(text.length / 4),
})

describe('BM25Index', () => {
  it('ranks a document containing the query term above one that does not', () => {
    const index = createBM25Index([
      doc('a', 'photosynthesis converts light energy into chemical energy in plants'),
      doc('b', 'mitochondria produce ATP through cellular respiration'),
      doc('c', 'the water cycle moves water between ocean and atmosphere'),
    ])
    const [top] = index.search('photosynthesis', 10)
    expect(top.documentId).toBe('a')
    expect(top.rank).toBe(1)
  })

  it('scores a rare term above a common one', () => {
    // "chloroplast" appears once, "cell" in all three, so IDF should favour the rare term.
    const index = createBM25Index([
      doc('a', 'the chloroplast is a cell organelle'),
      doc('b', 'a cell has a membrane and a nucleus'),
      doc('c', 'every cell divides during mitosis'),
    ])
    const rare = index.search('chloroplast', 10)
    const common = index.search('cell', 10)
    expect(rare[0].score).toBeGreaterThan(common[0].score)
  })

  it('returns nothing for an empty query or no match', () => {
    const index = createBM25Index([doc('a', 'some indexed content here')])
    expect(index.search('', 10)).toEqual([])
    expect(index.search('   ', 10)).toEqual([])
    expect(index.search('unrelated vocabulary', 10)).toEqual([])
  })

  it('respects topK and returns contiguous ranks', () => {
    const index = createBM25Index(
      Array.from({ length: 10 }, (_, i) => doc(`d${i}`, `shared term plus filler number ${i}`)),
    )
    const results = index.search('shared term', 3)
    expect(results).toHaveLength(3)
    expect(results.map((r) => r.rank)).toEqual([1, 2, 3])
  })

  it('handles an empty corpus without dividing by zero', () => {
    const index = createBM25Index([])
    expect(index.size).toBe(0)
    expect(index.search('anything', 5)).toEqual([])
  })

  it('normalises for document length', () => {
    // Same single occurrence of the term; the shorter document should score higher.
    const index = createBM25Index([
      doc('short', 'glucose'),
      doc('long', 'glucose ' + 'unrelated padding words here '.repeat(40)),
    ])
    const results = index.search('glucose', 10)
    expect(results[0].documentId).toBe('short')
  })
})
