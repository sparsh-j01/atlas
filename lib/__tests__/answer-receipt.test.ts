import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_GRACE_MS } from '@/lib/realtime/session-state'

vi.mock('server-only', () => ({}))

// The answer clock runs from the SERVER'S RECEIPT of the answer, not from whenever the route
// gets a DB connection. Under a classroom burst the read below waits seconds for a pooled
// connection; stamped after it, that wait counted against the student's window and score.
// The read is mocked to "take" QUEUE_MS of wall clock, so moving the stamp after it fails here.

const LIMIT = 20_000
const QUEUE_MS = 3_000
const OPT = 'opt-a'
let startedAt: Date
let inserted: { responseMs: number } | undefined

// Any chain of builder calls; awaiting it yields `result()`.
function chain(result: () => unknown): unknown {
  const p: unknown = new Proxy(() => {}, {
    get: (_t, prop) =>
      prop === 'then'
        ? (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => Promise.resolve().then(result).then(ok, err)
        : () => p,
    apply: () => p,
  })
  return p
}

vi.mock('@/lib/realtime/broadcast', () => ({ broadcastToHost: async () => {} }))
vi.mock('@/lib/realtime/live-slide', () => ({
  currentSlideLateral: () => ({ id: 'id', type: 'type', prompt: 'prompt', config: 'config', index: 'index' }),
  tallySlideAnswers: async () => ({}),
}))
vi.mock('@/lib/db', () => ({
  db: {
    // The one read: room + caller + live slide. Resolves only after the pool "queue".
    select: () =>
      chain(() => {
        vi.setSystemTime(Date.now() + QUEUE_MS)
        return [
          {
            session: { id: 's1', status: 'active', currentSlideStartedAt: startedAt },
            participantId: 'p1',
            slide: {
              id: 'slide1',
              type: 'quiz_mcq',
              prompt: 'Q',
              config: { options: [{ id: OPT, text: 'A', is_correct: true }, { id: 'opt-b', text: 'B' }], timeLimitMs: LIMIT, points: 1000 },
            },
          },
        ]
      }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => chain(() => [{ streak: 0, status: 'active', currentSlideStartedAt: startedAt }]),
        $with: () => ({
          as: (q: unknown) => q,
        }),
        insert: () => ({
          values: (v: { responseMs: number }) => {
            inserted = v
            return chain(() => [{ id: 'a1' }])
          },
        }),
        with: () => chain(() => [{ id: 'p1' }]),
      }),
    update: () => chain(() => []), // lost the broadcast window: no counts, no broadcast
  },
}))

const { POST } = await import('@/app/api/sessions/[code]/answer/route')

const answer = () =>
  POST(
    new Request('http://localhost/api/sessions/123456/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientToken: '00000000-0000-4000-8000-00000000c0de', optionId: OPT }),
    }),
    { params: Promise.resolve({ code: '123456' }) },
  )

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  inserted = undefined
})
afterEach(() => vi.useRealTimers())

describe('answer: the clock is the server receipt time', () => {
  it('accepts an answer received inside the window, however long the read then waits', async () => {
    const edge = LIMIT + ANSWER_GRACE_MS - 500 // received 500 ms before the deadline
    startedAt = new Date(Date.now() - edge)
    expect(await (await answer()).json()).toEqual({ accepted: true })
    // ...and scores it from receipt too: the queue is not charged to the student's speed.
    expect(inserted?.responseMs).toBe(edge)
  })

  it('still rejects an answer that was received after the window', async () => {
    startedAt = new Date(Date.now() - (LIMIT + ANSWER_GRACE_MS + 1))
    expect(await (await answer()).json()).toEqual({ accepted: false, reason: 'late' })
    expect(inserted).toBeUndefined()
  })
})
