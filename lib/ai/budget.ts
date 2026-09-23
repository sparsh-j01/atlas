import 'server-only'
import { and, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { aiUsage } from '@/lib/db/schema'
import { costMicroUsd, monthlyBudgetMicroUsd } from '@/lib/usage'
import { logger } from '@/lib/logger'

export type Reservation = { id: string; model: string; maximumMicroUsd: number }
export class AiBudgetError extends Error {
  constructor() { super('AI spending limit reached. Try again later.') }
}

/** Serialize admission across instances. The reservation commits BEFORE fetch. A failed
 * bookkeeping connection fails closed; no provider request may start without this row.
 * ponytail: one global advisory lock and a month-sum per AI call, so every call in the app
 * admits one at a time. Fine at classroom volume; a running monthly total row is the upgrade. */
export async function reserveAiCall(kind: 'model' | 'embed', model: string, inputTokens: number, outputTokens: number): Promise<Reservation> {
  const priced = kind === 'embed'
    ? model === 'gemini-embedding-001'
    : ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'].includes(model)
  if (!priced) throw new AiBudgetError()
  if (![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) throw new AiBudgetError()
  // Reserve at the higher published post-promotion price, including calls spanning a price change.
  const maximumMicroUsd = costMicroUsd(model, inputTokens, outputTokens, Date.UTC(2027, 0, 1))
  if (!Number.isSafeInteger(maximumMicroUsd) || maximumMicroUsd < 1 || maximumMicroUsd > 2_000_000_000) throw new AiBudgetError()
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(731940, 1)`)
    // Read clock after waiting for the lock; month boundaries cannot use a stale window.
    const now = new Date()
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    // This month's rows only, settled or not. An unsettled reservation is money that may
    // have been spent in the month it was made; counted in every later month as well (the
    // earlier `OR settled = false`), each timed-out call shrank every future cap for good.
    const [row] = await tx.select({ spent: sql<number>`coalesce(sum(${aiUsage.costMicroUsd}), 0)::float8` })
      .from(aiUsage).where(gte(aiUsage.createdAt, start))
    if ((row?.spent ?? 0) + maximumMicroUsd > monthlyBudgetMicroUsd()) throw new AiBudgetError()
    const [reservation] = await tx.insert(aiUsage).values({
      kind, model, inputTokens, outputTokens, costMicroUsd: maximumMicroUsd, settled: false,
    }).returning({ id: aiUsage.id })
    return { id: reservation.id, model, maximumMicroUsd }
  }, { isolationLevel: 'read committed' })
}

/** Release unused headroom only on authoritative token usage, once. Missing or malformed
 * metadata, aborted calls, unreadable bodies and crashes retain their reservation. */
export async function settleAiCall(reservation: Reservation, inputTokens: number, outputTokens: number): Promise<void> {
  if (![inputTokens, outputTokens].every(n => Number.isSafeInteger(n) && n >= 0)) return
  try {
    await db.update(aiUsage).set({
      inputTokens, outputTokens,
      costMicroUsd: costMicroUsd(reservation.model, inputTokens, outputTokens), settled: true,
    }).where(and(eq(aiUsage.id, reservation.id), eq(aiUsage.settled, false)))
  } catch (error) {
    // Existing full-cost reservation remains charged if reconciliation fails.
    logger.error('ai reservation not settled', { error })
  }
}

/** A successful embedding response has no usage counters; charge the full estimate and
 * close it rather than carrying that already-accounted cost into every future month. */
export async function completeAiCallAtCeiling(reservation: Reservation): Promise<void> {
  try {
    await db.update(aiUsage).set({ settled: true })
      .where(and(eq(aiUsage.id, reservation.id), eq(aiUsage.settled, false)))
  } catch (error) {
    logger.error('ai reservation not settled', { error })
  }
}

/** Text-only request upper estimate: UTF-8 bytes plus protocol/schema overhead, not the
 * optimistic characters/4 average. Reject unpriced models before relying on this cap. */
export function inputTokenCeiling(serializedBody: string): number {
  return Buffer.byteLength(serializedBody, 'utf8') + 4096
}
