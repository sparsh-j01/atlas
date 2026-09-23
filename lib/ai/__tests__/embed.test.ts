import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env.server', () => ({ serverEnv: { geminiKey: 'test-key' } }))
const RESERVATION = { id: 'r1', model: 'm', maximumMicroUsd: 100 }
const budget = vi.hoisted(() => ({ reserve: vi.fn(), settle: vi.fn(async () => {}), complete: vi.fn(async () => {}) }))
vi.mock('../budget', () => ({
  reserveAiCall: budget.reserve,
  settleAiCall: budget.settle,
  completeAiCallAtCeiling: budget.complete,
  inputTokenCeiling: () => 1,
}))
budget.reserve.mockImplementation(async () => RESERVATION)
import { embed, embedBatch, EmbeddingDeadlineError, EMBEDDING_DIMENSION } from '../embed'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.clearAllMocks(); budget.reserve.mockImplementation(async () => RESERVATION) })
const values = () => Array.from({ length: EMBEDDING_DIMENSION }, () => 0.1)

describe('embedding spend', () => {
  it('releases the reservation of a refused call and keeps the status matchable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"quota"}', { status: 429 })))
    await expect(embed('text', 'RETRIEVAL_QUERY')).rejects.toThrow('embedding failed: 429')
    expect(budget.settle).toHaveBeenCalledWith(RESERVATION, 0, 0)
    expect(budget.complete).not.toHaveBeenCalled()
  })

  it('charges a successful call at its reserved ceiling (the endpoint reports no usage)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ embedding: { values: values() } }) })))
    await embed('text', 'RETRIEVAL_QUERY')
    expect(budget.complete).toHaveBeenCalledWith(RESERVATION)
    expect(budget.settle).not.toHaveBeenCalled()
  })
})

describe('embedding budgets', () => {
  it('does not start a request after the deadline', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(embed('text', 'RETRIEVAL_QUERY', { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(EmbeddingDeadlineError)
    expect(fetch).not.toHaveBeenCalled()
    expect(budget.reserve).not.toHaveBeenCalled()
  })

  it('aborts a stalled request within the supplied budget', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    vi.stubGlobal('fetch', fetch)
    const pending = expect(embed('text', 'RETRIEVAL_QUERY', { deadline: Date.now() + 250 })).rejects.toBeInstanceOf(EmbeddingDeadlineError)
    await vi.advanceTimersByTimeAsync(250)
    await pending
  })

  it('bounds response-body reading too', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn(async (_url, init: RequestInit) => ({
      ok: true,
      json: () => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted')))),
    })))
    const pending = expect(embed('text', 'RETRIEVAL_QUERY', { deadline: Date.now() + 250 })).rejects.toBeInstanceOf(EmbeddingDeadlineError)
    await vi.advanceTimersByTimeAsync(250)
    await pending
  })

  it('rejects a vector with non-finite or non-numeric values', async () => {
    const invalid = values(); invalid[0] = NaN
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ embedding: { values: invalid } }) })))
    await expect(embed('text', 'RETRIEVAL_QUERY')).rejects.toThrow('embedder returned')
  })

  it('preserves ordering across provider batches', async () => {
    const fetch = vi.fn(async (_url, init: RequestInit) => ({
      ok: true,
      json: async () => ({ embeddings: JSON.parse(init.body as string).requests.map((r: { content: { parts: { text: string }[] } }) => ({
        values: Array.from({ length: EMBEDDING_DIMENSION }, () => Number(r.content.parts[0].text)),
      })) }),
    }))
    vi.stubGlobal('fetch', fetch)
    const vectors = await embedBatch(Array.from({ length: 101 }, (_, i) => String(i)), 'RETRIEVAL_DOCUMENT')
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(vectors.map((v) => v[0])).toEqual(Array.from({ length: 101 }, (_, i) => i))
  })
})
