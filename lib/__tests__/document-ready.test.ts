import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth', () => ({ getAuthUser: async () => ({ id: 'owner' }) }))
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }), tooMany: vi.fn() }))
vi.mock('@/lib/usage', () => ({ aiBudgetRefusal: async () => null, refuse: vi.fn() }))
const mocks = vi.hoisted(() => ({ coverage: vi.fn(), start: vi.fn(), doc: vi.fn(), job: vi.fn(), progress: vi.fn(), retry: vi.fn(), advance: vi.fn() }))
vi.mock('@/lib/documents', async () => {
  const real = await vi.importActual<typeof import('../documents')>('../documents')
  return {
    getDocument: mocks.doc,
    documentCoverage: mocks.coverage,
    getLatestJob: mocks.job,
    ocrProgress: mocks.progress,
    retryDocument: mocks.retry,
    advanceDocument: mocks.advance,
    isStalled: real.isStalled,
    AWAITING_UPLOAD: real.AWAITING_UPLOAD,
    DELETED: real.DELETED,
    FAILED_STATES: real.FAILED_STATES,
    MAX_INGESTION_ATTEMPTS: 5,
  }
})
vi.mock('@/lib/ingestion', () => ({ startIngestion: mocks.start, RESUME_AT: { failed_ocr: 'ocr' } }))
vi.mock('@/lib/db', () => ({ db: {} }))
import { GET, POST } from '../../app/api/documents/[id]/process/route'

const params = { params: Promise.resolve({ id: 'doc' }) }
const post = () => POST(new Request('http://localhost/process', { method: 'POST' }), params)
const get = () => GET(new Request('http://localhost/process'), params)
beforeEach(() => vi.clearAllMocks())

describe('POST /process', () => {
  it('returns coverage when an already processed document is reused, and starts nothing', async () => {
    const coverage = { totalPages: 2, readPages: 1, unread: [{ pageNumber: 2, reason: 'empty' }], message: '1 page produced no text' }
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'ready' })
    mocks.coverage.mockResolvedValue(coverage)
    expect(await (await post()).json()).toEqual({ status: 'ready', done: true, coverage })
    expect(mocks.coverage).toHaveBeenCalledWith('doc', 'owner')
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('starts a background run and answers at once, instead of working inside the request', async () => {
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'ocr' })
    mocks.job.mockResolvedValue({ id: 'job' })
    expect(await (await post()).json()).toEqual({ status: 'ocr', started: true })
    expect(mocks.start).toHaveBeenCalledWith('job')
  })

  it('moves a failed document onto its resume stage before answering, so the first poll is not "failed"', async () => {
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'failed_ocr' })
    mocks.retry.mockResolvedValue({ id: 'job2' })
    expect(await (await post()).json()).toEqual({ status: 'ocr', started: true })
    expect(mocks.advance).toHaveBeenCalledWith('doc', 'failed_ocr', 'ocr', 'job2')
    expect(mocks.start).toHaveBeenCalledWith('job2')
  })

  it('refuses to process an upload that was never confirmed', async () => {
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'awaiting_upload' })
    expect((await post()).status).toBe(409)
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('treats a deleted document as missing', async () => {
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'deleted' })
    expect((await post()).status).toBe(404)
  })
})

describe('GET /process', () => {
  const now = Date.now()

  it('reports stalled when the run is mid-pipeline with no live lease and idle past 30s', async () => {
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'structuring', leaseUntil: null, updatedAt: new Date(now - 60_000), pageCount: 3 })
    expect(await (await get()).json()).toMatchObject({ status: 'structuring', done: false, stalled: true })
  })

  it('is not stalled while a run holds the lease', async () => {
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'structuring', leaseUntil: new Date(now + 60_000), updatedAt: new Date(now - 60_000), pageCount: 3 })
    expect(await (await get()).json()).toMatchObject({ stalled: false })
  })

  it('carries OCR progress while images are being read', async () => {
    mocks.doc.mockResolvedValue({ id: 'doc', status: 'ocr', leaseUntil: new Date(now + 60_000), updatedAt: new Date(now), pageCount: 25 })
    mocks.progress.mockResolvedValue({ done: 15, total: 25 })
    expect(await (await get()).json()).toMatchObject({ status: 'ocr', progress: { done: 15, total: 25 } })
  })
})
