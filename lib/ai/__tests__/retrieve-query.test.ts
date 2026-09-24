import { beforeEach, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ select: vi.fn(), embed: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { select: mocks.select } }))
vi.mock('../embed', () => ({
  embed: mocks.embed,
  embeddingConfig: () => ({ provider: 'gemini', model: 'test-model', version: 'v2', dimension: 768 }),
}))
import { createRetriever } from '../retrieve'

const row = { id: 'owned', text: 'A passage about plants', tokenCount: 6, pageStart: 2, pageEnd: 2, charStart: 20, charEnd: 42, heading: 'Plants' }
beforeEach(() => { vi.clearAllMocks(); mocks.embed.mockResolvedValue([0.1, 0.2]) })

it('constrains vector SQL to the active population and retains the owner filter', async () => {
  const where = vi.fn()
  const vectorQuery = {
    from: () => vectorQuery, innerJoin: () => vectorQuery,
    where: (condition: SQL) => { where(condition); return vectorQuery },
    orderBy: () => vectorQuery,
    limit: async () => [{ chunkId: 'owned', similarity: 0.8 }, { chunkId: 'foreign', similarity: 0.99 }],
  }
  const corpusWhere = vi.fn()
  const corpus = {
    from: () => corpus, innerJoin: () => corpus,
    where: (condition: SQL) => { corpusWhere(condition); return corpus },
    orderBy: async () => [row],
  }
  mocks.select.mockReturnValueOnce(corpus).mockReturnValue(vectorQuery)
  const retriever = await createRetriever('doc', 'owner')
  const deadline = Date.now() + 1000
  const result = await retriever.retrieve('plants', 8, { deadline })
  const query = new PgDialect().sqlToQuery(where.mock.calls[0][0])
  expect(query.params).toEqual(['doc', 'gemini', 'test-model', 'v2', 768])
  for (const column of ['provider', 'model', 'version', 'dimension']) expect(query.sql).toContain(`"embeddings"."${column}"`)
  expect(new PgDialect().sqlToQuery(corpusWhere.mock.calls[0][0]).params).toEqual(['doc', 'owner'])
  expect(result.map((r) => r.chunkId)).toEqual(['owned'])
  expect(mocks.embed).toHaveBeenCalledWith('plants', 'RETRIEVAL_QUERY', { deadline })
})

it('across several files: one outline entry per file per heading, and scoped search stays in its file', async () => {
  const a = { ...row, id: 'a1', documentId: 'docA', filename: 'week1.pdf', heading: 'Introduction', text: 'photosynthesis light' }
  const b = { ...row, id: 'b1', documentId: 'docB', filename: 'week2.pdf', heading: 'Introduction', text: 'photosynthesis dark reactions' }
  const where = vi.fn()
  const vectorQuery = {
    from: () => vectorQuery, innerJoin: () => vectorQuery,
    where: (condition: SQL) => { where(condition); return vectorQuery },
    orderBy: () => vectorQuery,
    limit: async () => [{ chunkId: 'b1', similarity: 0.8 }],
  }
  const corpusWhere = vi.fn()
  const corpus = {
    from: () => corpus, innerJoin: () => corpus,
    where: (condition: SQL) => { corpusWhere(condition); return corpus },
    orderBy: async () => [a, b],
  }
  mocks.select.mockReturnValueOnce(corpus).mockReturnValue(vectorQuery)
  const retriever = await createRetriever(['docA', 'docB'], 'owner')

  // Deduped by heading alone, week2's "Introduction" vanished from the blueprint's outline.
  expect(retriever.outline().map((o) => `${o.filename}:${o.heading}`)).toEqual(['week1.pdf:Introduction', 'week2.pdf:Introduction'])
  expect(new PgDialect().sqlToQuery(corpusWhere.mock.calls[0][0]).params).toEqual(['docA', 'docB', 'owner'])

  const scoped = await retriever.retrieve('photosynthesis', 8, { documentId: 'docB' })
  expect(new PgDialect().sqlToQuery(where.mock.calls[0][0]).params[0]).toBe('docB')
  expect(scoped.map((r) => r.chunkId)).toEqual(['b1'])
  expect(scoped[0].source).toMatchObject({ documentId: 'docB', filename: 'week2.pdf' })
})
