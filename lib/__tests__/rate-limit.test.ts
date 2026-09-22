import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// An in-memory stand-in for the one upsert the limiter issues. It keeps the property the real
// statement has — the count that comes back is the count after THIS hit — which is all the
// limiter's arithmetic depends on. Atomicity under concurrency is Postgres's job; the live
// check run against the database covers that.
const rows = new Map<string, number>()
let lastKey = ''

vi.mock('@/lib/db', async () => {
  const { PgDialect } = await import('drizzle-orm/pg-core')
  return {
    db: {
      // peekLimit's read: the WHERE renders to [key, expires_at] params, looked up in the same map.
      select: () => ({
        from: () => ({
          where: (cond: import('drizzle-orm').SQL) => ({
            limit: async () => {
              const [key, expiresAt] = new PgDialect().sqlToQuery(cond).params as [string, string]
              const count = rows.get(`${key}|${expiresAt}`)
              return count === undefined ? [] : [{ count }]
            },
          }),
        }),
      }),
      insert: () => ({
        values: (v: { key: string; expiresAt: Date }) => ({
          onConflictDoUpdate: () => ({
            returning: async () => {
              lastKey = v.key
              const id = `${v.key}|${v.expiresAt.toISOString()}`
              const count = (rows.get(id) ?? 0) + 1
              rows.set(id, count)
              return [{ count }]
            },
          }),
        }),
      }),
    },
  }
})

const { LIMITS, checkLimit, clientIp, peekLimit, tooMany, waitMessage } = await import('../rate-limit')

beforeEach(() => rows.clear())

describe('every declared limit', () => {
  // The brief: "write tests that exceed each limit". One loop over the table, so a limit added
  // later is covered without anyone remembering to add a test for it.
  for (const [name, { limit, windowMs }] of Object.entries(LIMITS)) {
    it(`${name}: allows ${limit} per ${windowMs / 60_000} min, refuses the next with a Retry-After`, async () => {
      const now = Date.UTC(2026, 9, 4, 12, 0, 30) // 30s into a minute, mid-window for every length
      for (let i = 0; i < limit; i++)
        expect(await checkLimit(name as keyof typeof LIMITS, 'subject', now)).toEqual({ ok: true })

      const over = await checkLimit(name as keyof typeof LIMITS, 'subject', now)
      expect(over.ok).toBe(false)
      if (!over.ok) {
        expect(over.retryAfterSec).toBeGreaterThan(0)
        expect(over.retryAfterSec).toBeLessThanOrEqual(windowMs / 1000)
      }

      // A different subject has its own budget, and the next window starts fresh.
      expect(await checkLimit(name as keyof typeof LIMITS, 'someone-else', now)).toEqual({ ok: true })
      expect(await checkLimit(name as keyof typeof LIMITS, 'subject', now + windowMs)).toEqual({ ok: true })
    })
  }
})

describe('checkLimit', () => {
  it('never stores the subject in the clear', async () => {
    await checkLimit('signInPerEmail', 'teacher@school.example')
    expect(lastKey).toMatch(/^signInPerEmail:[0-9a-f]{64}$/)
    expect(lastKey).not.toContain('teacher')
  })

  it('reports the wait until the window ends', async () => {
    const start = Date.UTC(2026, 9, 4, 12, 0, 0)
    for (let i = 0; i <= LIMITS.aiPerUser.limit; i++) await checkLimit('aiPerUser', 'u', start + 45_000)
    const v = await checkLimit('aiPerUser', 'u', start + 45_000)
    expect(v).toEqual({ ok: false, retryAfterSec: 15 })
  })
})

describe('peekLimit', () => {
  it('reads without counting, and refuses once the limit is already spent', async () => {
    const now = Date.UTC(2026, 9, 4, 12, 3, 0)
    expect(await peekLimit('joinMissPerIp', '203.0.113.5', now)).toEqual({ ok: true })
    expect(rows.size).toBe(0) // a peek writes nothing
    for (let i = 0; i < LIMITS.joinMissPerIp.limit; i++) await checkLimit('joinMissPerIp', '203.0.113.5', now)
    const v = await peekLimit('joinMissPerIp', '203.0.113.5', now)
    expect(v.ok).toBe(false)
    expect(await peekLimit('joinMissPerIp', '198.51.100.1', now)).toEqual({ ok: true })
  })
})

describe('responses', () => {
  it('tooMany is our { error } shape, 429, with Retry-After', async () => {
    const res = tooMany(42)
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('42')
    expect(await res.json()).toEqual({ error: expect.any(String) })
  })

  it('waitMessage rounds up to whole minutes', () => {
    expect(waitMessage(30)).toBe('Too many attempts. Try again in 1 minute.')
    expect(waitMessage(61)).toBe('Too many attempts. Try again in 2 minutes.')
  })

  it('clientIp takes the first forwarded address and falls back', () => {
    expect(clientIp(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }))).toBe('203.0.113.7')
    expect(clientIp(new Headers({ 'x-real-ip': '198.51.100.2' }))).toBe('198.51.100.2')
    expect(clientIp(new Headers())).toBe('unknown')
  })
})
