import 'server-only'

import { NextResponse } from 'next/server'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { aiUsage, entitlements } from '@/lib/db/schema'
import { logger } from '@/lib/logger'
import { PLAN_LIMITS, isPlan, type Plan } from '@/lib/plans'
import { countHit } from '@/lib/rate-limit'

// AI spend: what every model call cost, what each creator may start, and the global brake.
//
// Gemini billing is on, so spend is real money. Three layers, cheapest first:
//   - per-minute rate limits (lib/rate-limit.ts) stop a loop;
//   - per-creator daily/monthly AI-deck quotas (PLAN_LIMITS) stop one account;
//   - the monthly budget stops everything, whoever is spending.
// The last is the only one that bounds the bill, so it is computed from what the calls
// actually cost, recorded per call below — not from a count of decks.

// --- Prices -------------------------------------------------------------------------------

// USD per 1M tokens, paid tier, from ai.google.dev/gemini-api/docs/pricing (read 2026-10-04).
// USD per 1M tokens is numerically micro-USD per token, which is the unit stored.
type Price = { input: number; output: number }
const GEMINI_3_FLASH: Price = { input: 0.75, output: 3.75 } // listed "through December 31, 2026"
const GEMINI_3_FLASH_2027: Price = { input: 1.5, output: 7.5 } // "starting January 1, 2027"
const PRICES: Record<string, Price> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  // OCR (lib/ingest/ocr.ts). Read off the pricing page 2026-10-05, Standard paid tier.
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
  // Not on the pricing page; priced at the listed embedding rate (Gemini Embedding 2, $0.20),
  // which errs high.
  'gemini-embedding-001': { input: 0.2, output: 0 },
}

/** A model this table does not know is priced at the most expensive rate it does, so a model
 *  swap can only make the budget trip early, never late. Output includes thinking tokens. */
export function priceFor(model: string, now = Date.now()): Price {
  if (PRICES[model]) return PRICES[model]
  if (/^gemini-3(\.\d+)?-flash$/.test(model))
    return now < Date.UTC(2027, 0, 1) ? GEMINI_3_FLASH : GEMINI_3_FLASH_2027
  return GEMINI_3_FLASH_2027
}

export function costMicroUsd(model: string, inputTokens: number, outputTokens: number, now = Date.now()) {
  const p = priceFor(model, now)
  return Math.ceil(inputTokens * p.input + outputTokens * p.output)
}

// --- Periods (UTC) ------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000
const dayStart = (now: number) => new Date(Math.floor(now / DAY_MS) * DAY_MS)
const dayEnd = (now: number) => new Date(dayStart(now).getTime() + DAY_MS)
const monthStart = (now: number) => {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
}
const monthEnd = (now: number) => {
  const d = new Date(now)
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))
}
const monthKey = (now: number) => new Date(now).toISOString().slice(0, 7)
const secondsUntil = (end: Date, now: number) => Math.max(1, Math.ceil((end.getTime() - now) / 1000))
const usd = (micro: number) => (micro / 1_000_000).toFixed(2)

// --- Plans and quotas ---------------------------------------------------------------------

export async function getPlan(ownerId: string): Promise<Plan> {
  const [row] = await db
    .select({ plan: entitlements.plan })
    .from(entitlements)
    .where(eq(entitlements.ownerId, ownerId))
    .limit(1)
  return isPlan(row?.plan) ? row.plan : 'free'
}

/** AI deck runs this creator started today and this month (UTC). */
export async function aiDeckCounts(ownerId: string, now = Date.now()): Promise<{ today: number; month: number }> {
  const [row] = await db
    .select({
      // An ISO string with a cast, not a Date: a value interpolated into a raw `sql` template
      // skips the column's own mapping, and postgres.js throws ERR_INVALID_ARG_TYPE on a Date
      // there. gte(column, date) below is fine — it maps through the column. Found by the
      // first live run; every unit test mocked the database.
      today: sql<number>`(count(*) filter (where ${aiUsage.createdAt} >= ${dayStart(now).toISOString()}::timestamptz))::int`,
      month: sql<number>`count(*)::int`,
    })
    .from(aiUsage)
    .where(and(eq(aiUsage.ownerId, ownerId), eq(aiUsage.kind, 'deck'), gte(aiUsage.createdAt, monthStart(now))))
  return { today: row?.today ?? 0, month: row?.month ?? 0 }
}

export async function monthSpendMicroUsd(now = Date.now()): Promise<number> {
  const [row] = await db
    .select({ spent: sql<number>`coalesce(sum(${aiUsage.costMicroUsd}), 0)::float8` })
    .from(aiUsage)
    .where(gte(aiUsage.createdAt, monthStart(now))) // same window as reserveAiCall, see there
  return row?.spent ?? 0
}

/** `AI_MONTHLY_BUDGET_USD`, default 5 (decided 2026-10-04). An unreadable value falls back to
 *  the default rather than to "no cap". */
export function monthlyBudgetMicroUsd(): number {
  const raw = Number(process.env.AI_MONTHLY_BUDGET_USD ?? 5)
  return Math.round((Number.isFinite(raw) && raw >= 0 ? raw : 5) * 1_000_000)
}

export type Refusal = { status: 403 | 429 | 503; error: string; retryAfterSec?: number }

export function refuse(r: Refusal) {
  return NextResponse.json(
    { error: r.error },
    { status: r.status, headers: r.retryAfterSec ? { 'Retry-After': String(r.retryAfterSec) } : undefined },
  )
}

/** The global brake, checked before any work that spends money (deck generation, document
 *  processing). Alerts at 80% and at 100%, once each per month.
 *
 *  This is an early UI refusal. Every provider call additionally reserves its cost atomically
 *  in lib/ai/budget.ts before fetch; outstanding reservations count toward this total. */
export async function aiBudgetRefusal(now = Date.now()): Promise<Refusal | null> {
  const spent = await monthSpendMicroUsd(now)
  const cap = monthlyBudgetMicroUsd()
  const end = monthEnd(now)
  const month = monthKey(now)
  if (spent >= cap) {
    await alertOnce(
      `budget100:${month}`,
      end,
      `Atlas AI spend reached the monthly cap: $${usd(spent)} of $${usd(cap)}. AI generation is OFF for everyone until ${month} ends.`,
    )
    return {
      status: 503,
      error: 'AI generation is paused for the rest of the month. Hand-built decks still work.',
      retryAfterSec: secondsUntil(end, now),
    }
  }
  if (spent >= 0.8 * cap)
    await alertOnce(
      `budget80:${month}`,
      end,
      `Atlas AI spend is at ${Math.floor((spent / cap) * 100)}% of the monthly cap: $${usd(spent)} of $${usd(cap)}.`,
    )
  return null
}

/** Gate AND reserve one AI deck run: the budget, the plan, today's and this month's quota.
 *  On success the run is counted immediately, so overlapping requests each see it. Returns a
 *  refusal to send, or null to proceed.
 *
 *  ponytail: count-then-insert, so a burst of simultaneous requests can overshoot a quota by
 *  the burst size. `aiPerUser` (3 a minute) bounds the burst. */
export async function startAiDeck(ownerId: string, source: 'topic' | 'pdf', now = Date.now()): Promise<Refusal | null> {
  const budget = await aiBudgetRefusal(now)
  if (budget) return budget

  const plan = await getPlan(ownerId)
  const limits = PLAN_LIMITS[plan]
  if (source === 'pdf' && !limits.documents)
    return { status: 403, error: 'Generating from a document is not included in your plan.' }

  const { today, month } = await aiDeckCounts(ownerId, now)
  if (month >= limits.aiDecksPerMonth)
    return {
      status: 429,
      error: `You have used this month's ${limits.aiDecksPerMonth} AI decks.`,
      retryAfterSec: secondsUntil(monthEnd(now), now),
    }
  if (today >= limits.aiDecksPerDay)
    return {
      status: 429,
      error: `You have used today's ${limits.aiDecksPerDay} AI decks. More tomorrow.`,
      retryAfterSec: secondsUntil(dayEnd(now), now),
    }

  await db.insert(aiUsage).values({ ownerId, kind: 'deck', createdAt: new Date(now) })

  if (month + 1 >= Math.ceil(0.8 * limits.aiDecksPerMonth))
    await alertOnce(
      `quota80:${ownerId}:${monthKey(now)}`,
      monthEnd(now),
      `Atlas creator ${ownerId} (${plan}) has started ${month + 1} of ${limits.aiDecksPerMonth} AI decks this month.`,
    )
  return null
}

// --- Alerts -------------------------------------------------------------------------------

/** Send `text` to ALERT_WEBHOOK_URL at most once per `key` until `expiresAt`. The once-ness
 *  rides on the rate-limit table: the first hit counts 1, every later one more.
 *
 *  ponytail: the marker is written before the send, so a webhook that is down loses that
 *  alert for the period. The warn line below still carries the text to the log. */
export async function alertOnce(key: string, expiresAt: Date, text: string): Promise<void> {
  try {
    if ((await countHit(`alert:${key}`, expiresAt)) !== 1) return
    logger.warn('alert', { key, text })
    const url = process.env.ALERT_WEBHOOK_URL?.trim()
    if (!url) return
    // Discord reads `content`, Slack reads `text`.
    const body = /discord(app)?\.com\//.test(url) ? { content: text } : { text }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    })
    if (!res.ok) logger.error('alert webhook refused', { key, status: res.status })
  } catch (e) {
    logger.error('alert not sent', { key, reason: String(e) })
  }
}
