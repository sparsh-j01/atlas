import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

vi.mock('server-only', () => ({}))

// Deleting a document has three properties that each fail silently if broken:
//   - a storage failure must stop the delete (or the teacher is told a file is gone while it
//     is still stored, with no row left to find it by);
//   - a recent upload must leave a tombstone (or delete resets the hourly upload quota, and
//     upload → process → delete is an unmetered loop on the project's Gemini quota);
//   - tombstones must never show up in the teacher's list.

const state = {
  getQueue: [] as unknown[][], // rows returned by successive `.limit()` reads (getDocument)
  stale: [] as unknown[], // rows returned by staleDocuments
  deletedRow: null as null | { createdAt: Date; sourceType: string },
  inserted: [] as unknown[],
  purged: 0,
  wheres: [] as SQL[],
  updated: [] as unknown[], // rows returned by `.update().set().where().returning()`
  jobUpdates: 0,
}

vi.mock('@/lib/db', () => {
  const read = {
    select: () => read,
    from: () => read,
    where: (cond: SQL) => {
      state.wheres.push(cond)
      return {
        limit: async () => state.getQueue.shift() ?? [],
        orderBy: async () => [],
        then: (resolve: (v: unknown) => unknown) => resolve(state.stale),
      }
    },
  }
  const tx = {
    delete: () => ({
      where: () => ({ returning: async () => (state.deletedRow ? [state.deletedRow] : []) }),
    }),
    insert: () => ({ values: async (v: unknown) => void state.inserted.push(v) }),
  }
  return {
    db: {
      ...read,
      update: () => ({
        set: () => ({
          where: (cond: SQL) => {
            state.wheres.push(cond)
            return {
              // The documents update ends in .returning(); the job update is awaited bare.
              returning: async () => state.updated,
              then: (resolve: (v: unknown) => unknown) => {
                state.jobUpdates++
                return resolve(undefined)
              },
            }
          },
        }),
      }),
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
      delete: () => ({
        where: () => ({ returning: async () => Array.from({ length: state.purged }, (_, i) => ({ id: `t${i}` })) }),
      }),
    },
  }
})

const { deleteDocument, failDocument, listDocuments, reapDocuments, DELETED, UPLOAD_WINDOW_MS } =
  await import('../documents')
const { bearerMatches } = await import('../crypto')

// Canonical owner/hash.type, as the upload route builds it — storage-path.ts refuses anything else.
const OWNER = '00000000-0000-4000-8000-0000000000a1'
const HASH = 'a'.repeat(64)
const PATH = `${OWNER}/${HASH}.pdf`
const doc = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-4000-8000-0000000000d1',
  ownerId: OWNER,
  sourceType: 'pdf',
  contentHash: HASH,
  status: 'ready',
  storagePath: PATH,
  ...over,
})
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

beforeEach(() => {
  state.getQueue = []
  state.stale = []
  state.deletedRow = null
  state.inserted = []
  state.purged = 0
  state.wheres = []
  state.updated = []
  state.jobUpdates = 0
})

describe('deleteDocument', () => {
  it('stops before touching the row when storage refuses the remove', async () => {
    state.getQueue = [[doc()]]
    state.deletedRow = { createdAt: minutesAgo(5), sourceType: 'pdf' }
    const remove = vi.fn(async () => {
      throw new Error('storage down')
    })

    await expect(deleteDocument('00000000-0000-4000-8000-0000000000d1', OWNER, remove)).rejects.toThrow('storage down')
    expect(remove).toHaveBeenCalledWith(PATH)
    expect(state.inserted).toEqual([])
  })

  it('leaves an empty tombstone with the original created_at for an upload inside the window', async () => {
    const createdAt = minutesAgo(5)
    state.getQueue = [[doc()]]
    state.deletedRow = { createdAt, sourceType: 'pdf' }

    expect(await deleteDocument('00000000-0000-4000-8000-0000000000d1', OWNER, async () => {})).toBe(true)
    expect(state.inserted).toEqual([
      expect.objectContaining({
        ownerId: OWNER,
        status: DELETED,
        createdAt,
        filename: '',
        contentHash: '',
        storagePath: '',
      }),
    ])
  })

  it('leaves no tombstone once the upload is older than the quota window', async () => {
    state.getQueue = [[doc()]]
    state.deletedRow = { createdAt: new Date(Date.now() - UPLOAD_WINDOW_MS - 1000), sourceType: 'pdf' }

    expect(await deleteDocument('00000000-0000-4000-8000-0000000000d1', OWNER, async () => {})).toBe(true)
    expect(state.inserted).toEqual([])
  })

  it("never hands storage a path that isn't the row's own, and still deletes the row", async () => {
    // RLS lets an owner rewrite their own row's storage_path, e.g. to another creator's file.
    state.getQueue = [[doc({ storagePath: '00000000-0000-4000-8000-0000000000b2/victim.pdf' })]]
    state.deletedRow = { createdAt: minutesAgo(5), sourceType: 'pdf' }
    const remove = vi.fn(async () => {})
    expect(await deleteDocument('00000000-0000-4000-8000-0000000000d1', OWNER, remove)).toBe(true)
    expect(remove).not.toHaveBeenCalled()
  })

  it('reports false and removes nothing for a document that is not yours or not there', async () => {
    const remove = vi.fn(async () => {})
    expect(await deleteDocument('00000000-0000-4000-8000-0000000000d1', 'someone-else', remove)).toBe(false)
    expect(remove).not.toHaveBeenCalled()
  })
})

describe('reapDocuments', () => {
  const BAD = { contentHash: 'b'.repeat(64), storagePath: `${OWNER}/${'b'.repeat(64)}.pdf` }
  it('deletes stale uploads, counts a storage failure without stopping, and purges tombstones', async () => {
    state.stale = [doc({ id: '00000000-0000-4000-8000-00000000000a', status: 'chunking' }), doc({ id: '00000000-0000-4000-8000-00000000000b', status: 'uploaded', ...BAD })]
    state.getQueue = [[doc({ id: '00000000-0000-4000-8000-00000000000a' })], [doc({ id: '00000000-0000-4000-8000-00000000000b', ...BAD })]]
    state.deletedRow = { createdAt: minutesAgo(48 * 60), sourceType: 'pdf' }
    state.purged = 3

    const result = await reapDocuments(async (path) => {
      if (path === BAD.storagePath) throw new Error('storage down')
    })
    expect(result).toEqual({ reaped: 1, failed: 1, tombstones: 3 })
  })
})

describe('failDocument', () => {
  it('only lands while the document is still in the stage that failed', async () => {
    state.updated = [{ id: '00000000-0000-4000-8000-0000000000d1' }]
    expect(await failDocument('00000000-0000-4000-8000-0000000000d1', 'chunking', 'failed_chunking', 'job-1', 'CHUNKING_FAILED', 'x')).toBe(true)
    const { sql } = new PgDialect().sqlToQuery(state.wheres[0])
    expect(sql).toContain('"documents"."status" = $')
    expect(state.jobUpdates).toBe(1)
  })

  it('touches nothing, job row included, once another driver has moved it on', async () => {
    state.updated = []
    expect(await failDocument('00000000-0000-4000-8000-0000000000d1', 'chunking', 'failed_chunking', 'job-1', 'CHUNKING_FAILED', 'x')).toBe(false)
    expect(state.jobUpdates).toBe(0)
  })
})

describe('listDocuments', () => {
  it('never lists tombstones', async () => {
    await listDocuments(OWNER)
    const { sql } = new PgDialect().sqlToQuery(state.wheres.at(-1)!)
    expect(sql).toContain('"documents"."status" <> $')
  })
})

describe('bearerMatches (cron auth)', () => {
  it('refuses everything when the secret is unset or empty', () => {
    expect(bearerMatches('Bearer ', undefined)).toBe(false)
    expect(bearerMatches('Bearer ', '')).toBe(false)
    expect(bearerMatches(null, undefined)).toBe(false)
  })

  it('accepts only the exact bearer value', () => {
    expect(bearerMatches('Bearer s3cret', 's3cret')).toBe(true)
    expect(bearerMatches('Bearer s3cre', 's3cret')).toBe(false)
    expect(bearerMatches('s3cret', 's3cret')).toBe(false)
    expect(bearerMatches(null, 's3cret')).toBe(false)
  })
})
