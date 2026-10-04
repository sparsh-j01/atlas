import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { sessions } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({ broadcast: vi.fn(), broadcastToHost: vi.fn() }))
vi.mock('./broadcast', () => mocks)

let session: typeof sessions.$inferSelect
let lock: Promise<unknown> = Promise.resolve()
let transitions = 0
let locks = 0
function chain(result: () => unknown): unknown {
  const proxy: unknown = new Proxy(() => {}, {
    get: (_t, prop) => prop === 'then'
      ? (ok: (value: unknown) => unknown) => Promise.resolve(result()).then(ok)
      : () => proxy,
    apply: () => proxy,
  })
  return proxy
}
const people = [{ participantId: 'p1', nickname: 'Asha', avatarSeed: 'a', score: 900 }]
const executor = {
  select: () => ({ from: (table: { [key: symbol]: string }) => chain(() => table[Symbol.for('drizzle:Name')] === 'sessions' ? [{ ...session }] : people) }),
  update: () => ({ set: (patch: Partial<typeof session>) => chain(() => {
    if (patch.status) transitions++
    session = { ...session, ...patch }
    return [{ ...session }]
  }) }),
}
vi.mock('@/lib/db', () => ({ db: {
  ...executor,
  transaction: async (fn: (tx: typeof executor) => Promise<unknown>) => {
    locks++
    const work = lock.then(() => fn(executor))
    lock = work.catch(() => {})
    return work
  },
} }))

const { progressSession, questionDue } = await import('./session-progress')
const start = new Date('2026-10-05T12:00:00.000Z')
const expected = { index: 0, serverStartedAt: start.toISOString() }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(start.getTime() + 6000)
  vi.clearAllMocks()
  lock = Promise.resolve()
  transitions = 0
  locks = 0
  session = {
    id: 'session', deckId: 'deck', hostId: 'host', code: '123456', hostToken: 'host-token',
    status: 'active', currentSlideIndex: 0, currentSlideStartedAt: start,
    slideSnapshot: [0, 1].map((position) => ({ id: `q${position}`, position, type: 'quiz_mcq', prompt: `Q${position}`,
      config: { timeLimitMs: 5000, points: 1000, explanation: 'Secret explanation',
        options: [{ id: `right${position}`, text: 'Right', is_correct: true }, { id: `wrong${position}`, text: 'Wrong', is_correct: false }] } })),
    revealedSlideIds: [], createdAt: start, endedAt: null,
  }
})

describe('automatic session progression', () => {
  it('uses the server deadline plus network grace, and refuses early or stale requests', () => {
    expect(questionDue(session, expected, 5000, start.getTime() + 5749)).toBe(false)
    expect(questionDue(session, expected, 5000, start.getTime() + 5750)).toBe(true)
    expect(questionDue(session, { ...expected, index: 1 }, 5000, start.getTime() + 6000)).toBe(false)
    expect(questionDue({ ...session, status: 'ended' }, expected, 5000, start.getTime() + 6000)).toBe(false)
  })

  it('an early wake is told how long is left by the server clock, and takes no lock', async () => {
    // A phone whose clock runs 4 s fast wakes at server time +2 s; the question is due at +5.75 s.
    vi.setSystemTime(start.getTime() + 2000)
    expect(await progressSession({ ...session }, expected)).toEqual({ waitMs: 3750 })
    expect(locks).toBe(0)
    expect(transitions).toBe(0)
  })

  it('a wake for a question that already moved on gets the current state, not a transition', async () => {
    const state = await progressSession({ ...session, currentSlideIndex: 1 }, expected)
    expect(state && 'index' in state && state.index).toBe(1)
    expect(locks).toBe(0)
  })

  it('simultaneous deadline retries advance exactly once and never expose answers between questions', async () => {
    await Promise.all([progressSession({ ...session }, expected), progressSession({ ...session }, expected)])
    expect(transitions).toBe(1)
    expect(session.currentSlideIndex).toBe(1)
    expect(session.revealedSlideIds).toEqual(['q0'])
    const show = mocks.broadcast.mock.calls.find((call) => call[1] === 'slide:show')
    expect(show).toBeDefined()
    expect(JSON.stringify(show)).not.toContain('is_correct')
    expect(JSON.stringify(show)).not.toContain('Secret explanation')
    expect(mocks.broadcast.mock.calls.some((call) => call[1] === 'slide:reveal')).toBe(false)
    expect(mocks.broadcastToHost).toHaveBeenCalledWith('123456', 'leaderboard:update', expect.objectContaining({ completedIndex: 0 }))
  })

  it('ends automatically after the final question and records unanswered questions for review', async () => {
    session.currentSlideIndex = 1
    await progressSession({ ...session }, { ...expected, index: 1 })
    expect(session.status).toBe('ended')
    expect(session.endedAt).not.toBeNull()
    expect(session.revealedSlideIds).toEqual(['q1'])
    expect(mocks.broadcast).toHaveBeenCalledWith('123456', 'session:ended', expect.objectContaining({ fullRanking: expect.any(Array) }))
  })
})
