import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// The room-code scanning guard on join: misses are counted per IP, right codes never are, and
// once a network has spent its misses it is refused BEFORE the lookup — on a right code too,
// or a scanner would simply keep going until it hit one.

const LIVE = '123456'
const counts = new Map<string, number>()
const LIMIT = 60

vi.mock('@/lib/rate-limit', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/rate-limit')>()
  return {
    ...real,
    peekLimit: async (name: string, subject: string) =>
      (counts.get(`${name}:${subject}`) ?? 0) < LIMIT ? { ok: true } : { ok: false, retryAfterSec: 120 },
    checkLimit: async (name: string, subject: string) => {
      counts.set(`${name}:${subject}`, (counts.get(`${name}:${subject}`) ?? 0) + 1)
      return { ok: true }
    },
  }
})
vi.mock('@/lib/realtime/session-util', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/realtime/session-util')>()),
  findLiveSession: async (code: string) =>
    code === LIVE ? { id: 's1', status: 'lobby', currentSlideIndex: 0, currentSlideStartedAt: null } : null,
  newToken: () => 'tok',
}))
vi.mock('@/lib/realtime/session-state', () => ({ answersOpen: () => false }))
vi.mock('@/lib/realtime/live-slide', () => ({ currentSlide: async () => null, sanitizeSlide: (s: unknown) => s }))
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => [{ n: 0 }] }) }),
    insert: () => ({ values: () => ({ returning: async () => [{ id: 'p1' }] }) }),
  },
}))

const { POST } = await import('@/app/api/sessions/[code]/join/route')

const join = (code: string, ip = '203.0.113.5') =>
  POST(
    new Request(`http://localhost/api/sessions/${code}/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ nickname: 'Ada' }),
    }),
    { params: Promise.resolve({ code }) },
  )

beforeEach(() => counts.clear())

describe('join: wrong-code guard', () => {
  it('a right code never counts, however many join', async () => {
    for (let i = 0; i < 150; i++) expect((await join(LIVE)).status).toBe(200)
    expect(counts.size).toBe(0)
  })

  it('counts each wrong code against the IP', async () => {
    expect((await join('000001')).status).toBe(404)
    expect((await join('000002')).status).toBe(404)
    expect(counts.get('joinMissPerIp:203.0.113.5')).toBe(2)
  })

  it('once the misses are spent, refuses with 429 + Retry-After — on the right code too', async () => {
    for (let i = 0; i < LIMIT; i++) await join(String(100000 + i))
    const scanning = await join('999999')
    expect(scanning.status).toBe(429)
    expect(scanning.headers.get('Retry-After')).toBe('120')
    expect((await join(LIVE)).status).toBe(429)
  })

  it('another network is unaffected', async () => {
    for (let i = 0; i < LIMIT; i++) await join(String(100000 + i))
    expect((await join(LIVE, '198.51.100.20')).status).toBe(200)
  })
})
