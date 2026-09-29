import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), insert: vi.fn(), select: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: { transaction: mocks.transaction, insert: mocks.insert, select: mocks.select } }))
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import { AWAITING_UPLOAD, markUploaded, reserveUpload } from '../documents'
import { documents, ingestionJobs } from '../db/schema'

const input = { ownerId: 'owner', filename: 'lecture.pdf', sourceType: 'pdf' as const, fileSize: 10, contentHash: 'a'.repeat(64), storagePath: 'owner/file.pdf' }
beforeEach(() => vi.clearAllMocks())

describe('reserveUpload', () => {
  function insertChain(rows: unknown[]) {
    const onConflictDoNothing = vi.fn(() => ({ returning: async () => rows }))
    const values = vi.fn(() => ({ onConflictDoNothing }))
    mocks.insert.mockReturnValueOnce({ values })
    return { values, onConflictDoNothing }
  }

  it('reserves an awaiting_upload row, conflicting on the live owner+hash index', async () => {
    const chain = insertChain([{ id: 'doc' }])
    expect(await reserveUpload(input)).toEqual({ document: { id: 'doc' }, created: true })
    expect(chain.values).toHaveBeenCalledWith({ ...input, pageCount: 0, status: AWAITING_UPLOAD })
    const [config] = chain.onConflictDoNothing.mock.calls[0] as unknown as [{ target: unknown[] }]
    expect(config.target).toEqual([documents.ownerId, documents.contentHash])
  })

  it('returns the existing live document when the insert conflicts', async () => {
    insertChain([])
    mocks.select.mockReturnValueOnce({ from: () => ({ where: () => ({ limit: async () => [{ id: 'existing' }] }) }) })
    expect(await reserveUpload(input)).toEqual({ document: { id: 'existing' }, created: false })
  })

  it('renders an ON CONFLICT whose predicate matches the partial unique index', () => {
    // Postgres only uses a PARTIAL unique index for ON CONFLICT when the statement repeats its
    // predicate. Without the WHERE it fails with "no unique or exclusion constraint matching".
    const q = drizzle.mock()
      .insert(documents)
      .values({ ...input, pageCount: 0, status: AWAITING_UPLOAD })
      .onConflictDoNothing({ target: [documents.ownerId, documents.contentHash], where: sql`${documents.contentHash} <> ''` })
      .toSQL().sql
    expect(q).toContain('on conflict ("owner_id","content_hash") where "documents"."content_hash" <> \'\' do nothing')
  })
})

describe('markUploaded', () => {
  function tx(updated: unknown[]) {
    const jobValues = vi.fn(() => ({ returning: async () => [{ id: 'job' }] }))
    const txInsert = vi.fn(() => ({ values: jobValues }))
    const set = vi.fn(() => ({ where: () => ({ returning: async () => updated }) }))
    mocks.transaction.mockImplementationOnce((fn) => fn({ update: () => ({ set }), insert: txInsert }))
    return { set, txInsert, jobValues }
  }

  it('moves awaiting_upload to uploaded and creates the first job in the same transaction', async () => {
    const t = tx([{ id: 'doc' }])
    expect(await markUploaded('doc', 'owner', { pageCount: 3, fileSize: 99 })).toEqual({ id: 'job' })
    expect(t.set).toHaveBeenCalledWith(expect.objectContaining({ pageCount: 3, fileSize: 99, status: 'uploaded' }))
    expect(t.txInsert).toHaveBeenCalledWith(ingestionJobs)
    expect(t.jobValues).toHaveBeenCalledWith({ documentId: 'doc', status: 'uploaded', attempt: 1 })
  })

  it('creates no second job when the row already left awaiting_upload (a retried confirm)', async () => {
    const t = tx([])
    expect(await markUploaded('doc', 'owner', { pageCount: 3, fileSize: 99 })).toBeNull()
    expect(t.txInsert).not.toHaveBeenCalled()
  })
})
