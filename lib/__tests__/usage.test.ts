import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/logger', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// The three things that bound the Gemini bill: what a call is priced at, the global monthly
// brake, and the per-creator quota. Each refusal is checked for the status, the copy and the
// Retry-After a client needs, and the alerts for firing exactly once.

const state = {
  plan: null as string | null,
  today: 0,
  month: 0,
  spent: 0,
  inserted: [] as Record<string, unknown>[],
}
const alertCounts = new Map<string, number>()

vi.mock('@/lib/db', () => ({
  db: {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const rows =
            'plan' in fields
              ? state.plan
                ? [{ plan: state.plan }]
                : []
              : 'spent' in fields
                ? [{ spent: state.spent }]
                : [{ today: state.today, month: state.month }]
          return Object.assign(Promise.resolve(rows), { limit: async () => rows })
        },
      }),
    }),
    insert: () => ({ values: async (v: Record<string, unknown>) => void state.inserted.push(v) }),
  },
}))
vi.mock('@/lib/rate-limit', () => ({
  countHit: async (key: string) => {
    const n = (alertCounts.get(key) ?? 0) + 1
    alertCounts.set(key, n)
    return n
  },
}))

const { costMicroUsd, priceFor, startAiDeck, aiBudgetRefusal, monthlyBudgetMicroUsd, alertOnce } =
  await import('../usage')

const NOW = Date.UTC(2026, 9, 15, 12, 0, 0) // mid-October 2026, UTC
const sent: { url: string; body: unknown }[] = []

beforeEach(() => {
  Object.assign(state, { plan: null, today: 0, month: 0, spent: 0, inserted: [] })
  alertCounts.clear()
  sent.length = 0
  vi.stubEnv('AI_MONTHLY_BUDGET_USD', '5')
  vi.stubEnv('ALERT_WEBHOOK_URL', 'https://discord.com/api/webhooks/1/x')
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(init.body as string) })
      return new Response(null, { status: 204 })
    }),
  )
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('pricing', () => {
  it('prices per token from the per-million list, thinking billed as output', () => {
    // 1,000 in + 1,000 out on 2.5-flash: 1000*0.30 + 1000*2.50 micro-USD.
    expect(costMicroUsd('gemini-2.5-flash', 1000, 1000)).toBe(2800)
  })

  it('switches 3.x flash to the 2027 price on January 1', () => {
    expect(priceFor('gemini-3.7-flash', Date.UTC(2026, 11, 31))).toEqual({ input: 0.75, output: 3.75 })
    expect(priceFor('gemini-3.7-flash', Date.UTC(2027, 0, 1))).toEqual({ input: 1.5, output: 7.5 })
  })

  it('prices an unknown model at the most expensive known rate, never at zero', () => {
    expect(priceFor('gemini-9-ultra')).toEqual({ input: 1.5, output: 7.5 })
  })

  it('reads the budget from the env, and falls back to $5 on nonsense rather than to no cap', () => {
    expect(monthlyBudgetMicroUsd()).toBe(5_000_000)
    vi.stubEnv('AI_MONTHLY_BUDGET_USD', 'lots')
    expect(monthlyBudgetMicroUsd()).toBe(5_000_000)
  })
})

describe('global budget', () => {
  it('lets work through under 80% without alerting', async () => {
    state.spent = 3_000_000
    expect(await aiBudgetRefusal(NOW)).toBeNull()
    expect(sent).toEqual([])
  })

  it('alerts once at 80%, however many requests see it', async () => {
    state.spent = 4_100_000
    await aiBudgetRefusal(NOW)
    await aiBudgetRefusal(NOW)
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual({ content: expect.stringContaining('82%') })
  })

  it('refuses with 503 until the month ends once the cap is reached, and alerts once', async () => {
    state.spent = 5_000_000
    const r = await aiBudgetRefusal(NOW)
    expect(r).toMatchObject({ status: 503 })
    // 17 days and 12 hours to 1 November 00:00 UTC.
    expect(r?.retryAfterSec).toBe((16 * 24 + 12) * 3600)
    await aiBudgetRefusal(NOW)
    expect(sent).toHaveLength(1)
  })
})

describe('startAiDeck', () => {
  it('records the run when every check passes', async () => {
    expect(await startAiDeck('owner-1', 'topic', NOW)).toBeNull()
    expect(state.inserted).toEqual([expect.objectContaining({ ownerId: 'owner-1', kind: 'deck' })])
  })

  it('refuses at the daily quota with a Retry-After to UTC midnight, and records nothing', async () => {
    state.today = 20 // Free's lenient daily limit
    const r = await startAiDeck('owner-1', 'topic', NOW)
    expect(r).toMatchObject({ status: 429, retryAfterSec: 12 * 3600 })
    expect(state.inserted).toEqual([])
  })

  it('refuses at the monthly quota before the daily one', async () => {
    state.plan = 'pro'
    state.month = 500
    expect(await startAiDeck('owner-1', 'pdf', NOW)).toMatchObject({ status: 429, error: expect.stringContaining('month') })
  })

  it('a budget refusal wins over everything, and costs no quota', async () => {
    state.spent = 9_000_000
    expect(await startAiDeck('owner-1', 'topic', NOW)).toMatchObject({ status: 503 })
    expect(state.inserted).toEqual([])
  })

  it('treats an unknown plan value as free', async () => {
    state.plan = 'platinum'
    state.today = 20
    expect(await startAiDeck('owner-1', 'topic', NOW)).toMatchObject({ status: 429 })
  })

  it('alerts once when a creator reaches 80% of the month', async () => {
    state.month = 79 // Free: 100 a month; this run is the 80th
    await startAiDeck('owner-1', 'topic', NOW)
    await startAiDeck('owner-1', 'topic', NOW)
    expect(sent).toHaveLength(1)
    expect(sent[0].body).toEqual({ content: expect.stringContaining('80 of 100') })
  })
})

describe('alertOnce', () => {
  it('speaks Slack to a non-Discord webhook', async () => {
    vi.stubEnv('ALERT_WEBHOOK_URL', 'https://hooks.slack.com/services/T/B/x')
    await alertOnce('k', new Date(NOW + 1000), 'hello')
    expect(sent[0].body).toEqual({ text: 'hello' })
  })

  it('logs instead of sending when no webhook is configured', async () => {
    vi.stubEnv('ALERT_WEBHOOK_URL', '')
    await alertOnce('k2', new Date(NOW + 1000), 'hello')
    expect(sent).toEqual([])
  })
})
