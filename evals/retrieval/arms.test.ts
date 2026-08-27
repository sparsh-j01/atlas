import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { POOL_CONFIGS, createArmRetriever } from './arms'
import type { Retriever, RetrievalResult } from '@/lib/ai/retrieve'

describe('arms pool configurations', () => {
  it('defines Run A with production limits', () => {
    expect(POOL_CONFIGS.runA.vector.vectorLimit).toBe(20)
    expect(POOL_CONFIGS.runA.vector.bm25Limit).toBe(0)
    expect(POOL_CONFIGS.runA.bm25.vectorLimit).toBe(0)
    expect(POOL_CONFIGS.runA.bm25.bm25Limit).toBe(20)
    expect(POOL_CONFIGS.runA.hybrid.vectorLimit).toBe(20)
    expect(POOL_CONFIGS.runA.hybrid.bm25Limit).toBe(20)
  })

  it('defines Run B with budget-normalized limits', () => {
    expect(POOL_CONFIGS.runB.vector.vectorLimit).toBe(40)
    expect(POOL_CONFIGS.runB.vector.bm25Limit).toBe(0)
    expect(POOL_CONFIGS.runB.bm25.vectorLimit).toBe(0)
    expect(POOL_CONFIGS.runB.bm25.bm25Limit).toBe(40)
    expect(POOL_CONFIGS.runB.hybrid.vectorLimit).toBe(20)
    expect(POOL_CONFIGS.runB.hybrid.bm25Limit).toBe(20)
  })

  it('delegates to retriever.retrieve with the exact arm and pool configuration', async () => {
    const mockResult: RetrievalResult[] = [
      {
        chunkId: 'c1',
        text: 'hello',
        score: 0.9,
        rank: 1,
        similarity: 0.9,
        source: { page: 1, section: 'S', charStart: 0, charEnd: 5 },
      },
    ]

    const mockRetriever: Retriever = {
      chunkCount: () => 10,
      outline: () => [],
      retrieve: vi.fn().mockResolvedValue(mockResult),
    }

    const armRetriever = createArmRetriever(mockRetriever, POOL_CONFIGS.runB.vector)
    const results = await armRetriever.retrieve('quantum physics', 10)

    expect(results).toEqual(mockResult)
    expect(mockRetriever.retrieve).toHaveBeenCalledWith(
      'quantum physics',
      10,
      expect.objectContaining({
        arm: 'vector',
        vectorLimit: 40,
        bm25Limit: 0,
      }),
    )
  })

  it('exposes getLastTiming when onTiming callback is invoked', async () => {
    const mockRetriever: Retriever = {
      chunkCount: () => 10,
      outline: () => [],
      retrieve: vi.fn().mockImplementation(async (_q, _k, options) => {
        options?.onTiming?.({ totalMs: 500, embeddingMs: 450, searchMs: 50, cacheStatus: 'cache_miss' })
        return []
      }),
    }

    const armRetriever = createArmRetriever(mockRetriever, POOL_CONFIGS.runA.vector)
    await armRetriever.retrieve('neural networks', 10)

    expect(armRetriever.getLastTiming?.()).toEqual({
      totalMs: 500,
      embeddingMs: 450,
      searchMs: 50,
      cacheStatus: 'cache_miss',
    })
  })
})
