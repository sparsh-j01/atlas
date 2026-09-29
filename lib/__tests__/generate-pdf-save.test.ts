import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// The PDF route reserves a deck row BEFORE generating, so a failed run must delete it. Every
// early exit did; the final save did not, and a teacher deleting the source file mid-run
// (dashboard → Uploaded files) makes that save fail on the citation foreign key. The result
// was an empty untitled draft left on the dashboard and a raw 500. This drives the real route
// through to the save with the model, retriever and database stubbed.

const state = {
  limitQueue: [] as unknown[][],
  released: 0,
  saveError: new Error('insert or update on table "generation_sources" violates foreign key constraint'),
}

vi.mock('@/lib/auth', () => ({ getAuthUser: async () => ({ id: 'owner-1' }) }))
vi.mock('@/lib/rate-limit', () => ({ checkLimit: async () => ({ ok: true }), tooMany: vi.fn() }))
vi.mock('@/lib/usage', () => ({ startAiDeck: async () => null, refuse: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

vi.mock('@/lib/db', () => {
  const read = {
    select: () => read,
    from: () => read,
    where: () => ({
      limit: async () => state.limitQueue.shift() ?? [],
    }),
  }
  return {
    db: {
      ...read,
      insert: () => ({ values: () => ({ returning: async () => [{ id: 'deck-1' }] }) }),
      delete: () => ({
        where: async () => {
          state.released++
        },
      }),
      transaction: async () => {
        throw state.saveError
      },
    },
  }
})

vi.mock('@/lib/ai/retrieve', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/retrieve')>()),
  createRetriever: async () => ({
    chunkCount: () => 5,
    outline: () => [{ heading: 'Intro', pageStart: 1, pageEnd: 1 }],
    sample: () => [],
    retrieve: async () => [],
  }),
}))
vi.mock('@/lib/ai/generate', () => ({
  createGenerateClient: () => async () => ({ ok: true, input: {} }),
}))
vi.mock('@/lib/ai/blueprint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/blueprint')>()),
  parseBlueprint: () => ({
    ok: true,
    value: {
      title: 'T',
      description: null,
      slides: Array.from({ length: 8 }, (_, i) => ({ subtopic: `s${i}`, type: 'quiz_mcq' })),
    },
  }),
}))
vi.mock('@/lib/ai/validate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/validate')>()),
  finalizeSlides: () => ({
    ok: true,
    slides: [{ type: 'quiz_mcq', prompt: 'Q?', options: [] }],
    dropped: [],
  }),
}))

const { POST } = await import('@/app/api/decks/generate-pdf/route')

const call = () =>
  POST(new Request('http://localhost/api/decks/generate-pdf', { method: 'POST', body: JSON.stringify({ documentId: '00000000-0000-4000-8000-0000000000d1' }) }))

const readyDoc = { id: '00000000-0000-4000-8000-0000000000d1', ownerId: 'owner-1', status: 'ready', filename: 'lecture.pdf', storagePath: 'owner-1/x.pdf' }

beforeEach(() => {
  state.released = 0
})

describe('generate-pdf: a failed save releases the reserved deck', () => {
  it('says the file was deleted, and leaves no empty draft, when the source went mid-run', async () => {
    state.limitQueue = [[readyDoc], []] // the lookup at the start, then the re-check after the failure
    const res = await call()
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/deleted while the deck was being generated/)
    expect(state.released).toBe(1)
  })

  it('returns a plain 500 and still releases the draft when the document is still there', async () => {
    state.limitQueue = [[readyDoc], [{ id: '00000000-0000-4000-8000-0000000000d1' }]]
    const res = await call()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toMatch(/foreign key|generation_sources/)
    expect(state.released).toBe(1)
  })
})
