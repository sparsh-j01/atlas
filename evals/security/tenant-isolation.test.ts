import { describe, it, expect, vi } from 'vitest'

// lib/ai/retrieve.ts is `server-only`, which throws outside a React server runtime.
// Same stub the rest of the suite uses (see lib/ai/gemini.test.ts).
vi.mock('server-only', () => ({}))

const { scopeHitsToCorpus } = await import('@/lib/ai/retrieve')

/**
 * Phase 2D, master doc section 13 — tenant isolation, PATH B.
 *
 * Path A (the owner-scoped corpus load) is covered by the DB-backed scenario in
 * `evals/security/tenant-isolation.ts`, because it can only be proven against real rows.
 * These tests cover the control that Path A hides: the in-memory re-filter.
 *
 * The distinction matters, and the master doc is explicit about it: a test that passes
 * because the owner join worked has not tested the re-filter at all. `createRetriever` with
 * a foreign owner loads zero rows, and `vectorSearch` returns early on an empty corpus, so
 * the re-filter is never even reached on that path. Testing only the cross-owner scenario
 * would be testing one control twice and reporting it as two.
 */
describe('tenant isolation — Path B: vector hits are re-scoped to the owned corpus', () => {
  const owned = new Map([
    ['chunk-a1', { text: 'owned' }],
    ['chunk-a2', { text: 'owned' }],
  ])

  it('keeps hits whose chunk survived the owner-scoped load', () => {
    const hits = [
      { chunkId: 'chunk-a1', similarity: 0.91 },
      { chunkId: 'chunk-a2', similarity: 0.77 },
    ]
    expect(scopeHitsToCorpus(hits, owned)).toEqual(hits)
  })

  it('drops a chunk the vector SQL returned but the owner-scoped load did not', () => {
    // The exact shape of the leak this control exists for. The vector query filters on
    // documentId only, so any row the database is willing to return for that document
    // reaches this filter regardless of who owns it.
    const hits = [
      { chunkId: 'chunk-a1', similarity: 0.91 },
      { chunkId: 'chunk-b9', similarity: 0.99 }, // another tenant's chunk, higher scoring
      { chunkId: 'chunk-a2', similarity: 0.60 },
    ]
    const scoped = scopeHitsToCorpus(hits, owned)
    expect(scoped.map((h) => h.chunkId)).toEqual(['chunk-a1', 'chunk-a2'])
    expect(scoped.some((h) => h.chunkId === 'chunk-b9')).toBe(false)
  })

  it('drops the foreign chunk even when it is the single best match', () => {
    // Ranking must not buy an unowned chunk a place in the evidence block.
    const hits = [{ chunkId: 'chunk-b9', similarity: 1.0 }]
    expect(scopeHitsToCorpus(hits, owned)).toEqual([])
  })

  it('returns nothing when the owned corpus is empty', () => {
    const hits = [{ chunkId: 'chunk-b9', similarity: 0.99 }]
    expect(scopeHitsToCorpus(hits, new Map())).toEqual([])
  })

  it('is not a no-op — a pass-through implementation fails this suite', () => {
    // Guards the deletion this whole file exists to catch: if the filter is replaced by
    // `hits => hits`, the length assertion below is what breaks.
    const hits = [
      { chunkId: 'chunk-a1', similarity: 0.5 },
      { chunkId: 'unowned', similarity: 0.5 },
    ]
    expect(scopeHitsToCorpus(hits, owned)).toHaveLength(1)
  })
})
