import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({
  rows: [] as { id: string; text: string; embeddingId: string | null }[],
  batch: vi.fn(),
}))
vi.mock('@/lib/ai/embed', () => ({
  embedBatch: state.batch,
  embeddingConfig: () => ({ provider: 'gemini', model: 'model-a', version: 'v1', dimension: 768 }),
  EmbeddingDeadlineError: class extends Error {},
}))
vi.mock('@/lib/db', () => {
  const query = { from: () => query, leftJoin: () => query, where: () => query, orderBy: async () => state.rows.map((r) => ({ ...r })) }
  return { db: {
    select: () => query,
    insert: () => ({ values: (rows: { chunkId: string }[]) => ({ onConflictDoNothing: async () => {
      for (const inserted of rows) state.rows.find((r) => r.id === inserted.chunkId)!.embeddingId = 'saved'
    } }) }),
  } }
})
import { STAGES } from '../ingestion'
import type { Document } from '../documents'
const doc = { id: 'doc' } as Document
const stage = STAGES.find((s) => s.from === 'embedding')!
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); state.rows = Array.from({ length: 101 }, (_, i) => ({ id: String(i), text: String(i), embeddingId: null })) })
afterEach(() => vi.useRealTimers())

it('commits one batch before pausing and skips it on continuation', async () => {
  state.batch.mockImplementationOnce(async (texts: string[]) => {
    vi.setSystemTime(Date.now() + 7000)
    return texts.map(() => [0.1])
  }).mockImplementation(async (texts: string[]) => texts.map(() => [0.1]))
  expect(await stage.run(doc, Date.now() + 10_000)).toEqual({ done: false })
  expect(state.rows.filter((r) => r.embeddingId)).toHaveLength(100)
  expect(await stage.run(doc, Date.now() + 10_000)).toEqual({ done: true })
  expect(state.batch.mock.calls.map((call) => call[0].length)).toEqual([100, 1])
  expect(state.rows.every((r) => r.embeddingId)).toBe(true)
})

it('starts no provider request when the remaining budget is too short', async () => {
  expect(await stage.run(doc, Date.now() + 100)).toEqual({ done: false })
  expect(state.batch).not.toHaveBeenCalled()
})
