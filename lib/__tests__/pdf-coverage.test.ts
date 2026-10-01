import { beforeEach, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ texts: [''], written: [] as { rawText: string; unreadReason: string | null }[] }))
vi.mock('unpdf', () => ({
  extractText: async () => ({ text: state.texts, totalPages: state.texts.length }),
  getDocumentProxy: async () => ({ numPages: state.texts.length }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ storage: { from: () => ({ download: async () => ({ data: new Blob(['pdf']) }) }) } }) }))
vi.mock('@/lib/db', () => ({ db: { transaction: async (fn: (tx: unknown) => Promise<void>) => fn({
  delete: () => ({ where: async () => {} }),
  insert: () => ({ values: async (values: typeof state.written) => { state.written = values } }),
  update: () => ({ set: () => ({ where: async () => {} }) }),
}) } }))
import { STAGES } from '../ingestion'
import { PDF_FORMAT } from '../ingest/formats'
import type { Document } from '../documents'
const owner = '00000000-0000-4000-8000-0000000000a1', hash = 'c'.repeat(64)
const doc = { id: 'doc', ownerId: owner, contentHash: hash, sourceType: 'pdf', storagePath: `${owner}/${hash}.pdf` } as Document
const extraction = STAGES.find((s) => s.from === 'uploaded')!
beforeEach(() => { state.texts = []; state.written = [] })

it('records unread pages in a mixed PDF', async () => {
  state.texts = ['Readable page.', '', '   ', 'More readable material.']
  await extraction.run(doc, Date.now() + 5000)
  expect(state.written.map((p) => p.unreadReason)).toEqual([null, 'empty', 'empty', null])
})

it('rejects fully scanned PDFs after recording the missing text', async () => {
  state.texts = ['', ' ']
  await expect(extraction.run(doc, Date.now() + 5000)).rejects.toThrow('No extractable text')
  expect(state.written.every((p) => p.unreadReason === 'empty')).toBe(true)
})

it('does not reject a PDF merely because its first five pages have no text', async () => {
  state.texts = ['', '', '', '', '', 'Readable material on page six.']
  expect(await PDF_FORMAT.probe(new Uint8Array(), 200)).toEqual({ ok: true, pageCount: 6 })
  await extraction.run(doc, Date.now() + 5000)
  expect(state.written[5].unreadReason).toBeNull()
})

it('refuses to download a path that is not the row\'s own owner/hash/type', async () => {
  await expect(extraction.run({ ...doc, storagePath: 'someone-else/x.pdf' }, Date.now() + 5000)).rejects.toThrow('storage path does not match')
})
