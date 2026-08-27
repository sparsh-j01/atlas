import { describe, it, expect } from 'vitest'
import { rrfFromChunks } from '../rrf'

const list = (...ids: string[]) => ids.map((chunkId, i) => ({ chunkId, score: 1 - i * 0.1 }))

describe('rrfFromChunks', () => {
  it('rewards a chunk both retrievers rank highly', () => {
    // "b" is second in each list; "a" and "c" are first in only one.
    const fused = rrfFromChunks(list('a', 'b'), list('c', 'b'), 10)
    expect(fused[0].chunkId).toBe('b')
  })

  it('fuses by rank, not by score', () => {
    // Identical ranks, wildly different raw scores — the result must not change.
    const cheap = [{ chunkId: 'x', score: 0.001 }]
    const rich = [{ chunkId: 'x', score: 999 }]
    expect(rrfFromChunks(cheap, [], 10)[0].score).toBeCloseTo(rrfFromChunks(rich, [], 10)[0].score)
  })

  it('caps the fused score below any similarity-like threshold', () => {
    // Guards the bug this replaced: a 0.1 relevance floor applied to a fused score
    // rejected everything, because 2/(60+1) is the ceiling.
    const fused = rrfFromChunks(list('a'), list('a'), 10)
    expect(fused[0].score).toBeLessThan(0.034)
  })

  it('handles one empty list and two empty lists', () => {
    expect(rrfFromChunks(list('a', 'b'), [], 10).map((f) => f.chunkId)).toEqual(['a', 'b'])
    expect(rrfFromChunks([], [], 10)).toEqual([])
  })

  it('deduplicates ids across lists', () => {
    const fused = rrfFromChunks(list('a', 'b'), list('a', 'b'), 10)
    expect(fused.map((f) => f.chunkId).sort()).toEqual(['a', 'b'])
  })

  it('respects topK and renumbers ranks from 1', () => {
    const fused = rrfFromChunks(list('a', 'b', 'c', 'd'), list('e', 'f'), 3)
    expect(fused).toHaveLength(3)
    expect(fused.map((f) => f.rank)).toEqual([1, 2, 3])
  })
})
