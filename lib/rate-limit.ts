import 'server-only'

import { NextResponse } from 'next/server'
import { and, eq, lt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { rateLimits } from '@/lib/db/schema'
import { sha256 } from '@/lib/crypto'

// Fixed-window rate limits, counted in Postgres so every serverless instance sees the same
// number. One statement per check — INSERT ... ON CONFLICT DO UPDATE ... RETURNING — so two
// requests landing together each get their own count; there is no read-then-write to race.
//
// ponytail: fixed windows let a client spend up to 2x the limit across a window boundary.
// Fine for abuse ceilings; a sliding window (or Upstash) is the upgrade if that ever matters.

const MIN = 60_000

export type Limit = { limit: number; windowMs: number }

/** Every limit in one place, so one test can walk them all. */
export const LIMITS = {
  // Password guessing against one account. The brief's 5 per 15 minutes.
  signInPerEmail: { limit: 5, windowMs: 15 * MIN },
  // Anything that makes Supabase SEND an email: sign-up, resend confirmation, reset. Per
  // address, so nobody can flood one inbox or burn the project's email allowance on it.
  emailPerAddress: { limit: 5, windowMs: 15 * MIN },
  // Per IP, deliberately looser than per email: a school staff room shares one public IP, and
  // a per-IP limit at 5 would lock out the sixth teacher to sign in after a meeting. The same
  // reason participant join/answer/state have no per-IP limit at all (a class is one IP).
  authPerIp: { limit: 30, windowMs: 15 * MIN },
  oauthPerIp: { limit: 30, windowMs: 15 * MIN },
  // Email-link and OAuth-code verification. Junk tokens cost an attacker nothing, but each one
  // spends Supabase's verification allowance, which here is shared by every teacher (all calls
  // come from the server's IP). Looser than sign-in: a workshop confirms its accounts together.
  verifyPerIp: { limit: 60, windowMs: 15 * MIN },
  // Expensive work, per signed-in user.
  aiPerUser: { limit: 3, windowMs: MIN },
  // One call per file asks for an upload link; the builder takes up to 5 files in one drop,
  // plus a retry or two. The hourly UPLOADS_PER_HOUR cap is what bounds storage and spend.
  uploadPerUser: { limit: 10, windowMs: MIN },
  // Confirm and Resume start background runs; a run holds a lease, so extra calls are no-ops.
  // 60 only stops a loop.
  processPerUser: { limit: 60, windowMs: MIN },
  exportPerUser: { limit: 30, windowMs: MIN },
  // Host actions that BROADCAST to the room (start, end, kick). Each one is a fan-out
  // to every phone, and Supabase meters Realtime per delivered copy. A teacher clicks at most
  // about once a second; 60 a minute only stops a script. Roster is excluded on purpose: the
  // host console refetches it on every join, so a class arriving would trip it.
  hostActionPerSession: { limit: 60, windowMs: MIN },
  // WRONG room codes per IP. A live room is gated by a 6-digit code, a million values, so an
  // unlimited lookup is a way to hunt for live classes. Only misses count, and the check runs
  // before the lookup (peekLimit), so a correct code never spends anything and a real class —
  // one school IP, a handful of typos — never meets it. 60 per 10 minutes holds a scanner to
  // ~8,600 guesses a day per IP. The per-IP ban on participant routes (a class is one IP) is
  // about limiting JOINS; this limits only failures.
  joinMissPerIp: { limit: 60, windowMs: 10 * MIN },
} as const satisfies Record<string, Limit>

export type LimitName = keyof typeof LIMITS

export type Verdict = { ok: true } | { ok: false; retryAfterSec: number }

/** Count one hit against `key` in the window ending at `expiresAt`. Returns the new count. */
export async function countHit(key: string, expiresAt: Date): Promise<number> {
  const [row] = await db
    .insert(rateLimits)
    .values({ key, expiresAt, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimits.key, rateLimits.expiresAt],
      set: { count: sql`${rateLimits.count} + 1` },
    })
    .returning({ count: rateLimits.count })
  return row.count
}

/** One hit against a named limit for `subject` — an email, an IP, a user or session id. The
 *  subject is hashed, so the table never holds an address or an IP in the clear. */
export async function checkLimit(name: LimitName, subject: string, now = Date.now()): Promise<Verdict> {
  const { limit, windowMs } = LIMITS[name]
  const end = Math.floor(now / windowMs) * windowMs + windowMs
  const count = await countHit(`${name}:${await sha256(subject)}`, new Date(end))
  return count <= limit ? { ok: true } : { ok: false, retryAfterSec: Math.ceil((end - now) / 1000) }
}

/** Read a limit without counting a hit: refused once `limit` hits are already spent in the
 *  current window. For guards that count only failures — check first, `checkLimit` on a miss. */
export async function peekLimit(name: LimitName, subject: string, now = Date.now()): Promise<Verdict> {
  const { limit, windowMs } = LIMITS[name]
  const end = Math.floor(now / windowMs) * windowMs + windowMs
  const [row] = await db
    .select({ count: rateLimits.count })
    .from(rateLimits)
    .where(and(eq(rateLimits.key, `${name}:${await sha256(subject)}`), eq(rateLimits.expiresAt, new Date(end))))
    .limit(1)
  return (row?.count ?? 0) < limit ? { ok: true } : { ok: false, retryAfterSec: Math.ceil((end - now) / 1000) }
}

/** The standard refusal: our usual `{ error }` body, 429, and Retry-After in seconds. */
export function tooMany(retryAfterSec: number, error = 'Too many requests. Try again shortly.') {
  return NextResponse.json({ error }, { status: 429, headers: { 'Retry-After': String(retryAfterSec) } })
}

/** The same refusal for a server action, which has no status line: the wait goes in the copy. */
export function waitMessage(retryAfterSec: number): string {
  const minutes = Math.ceil(retryAfterSec / 60)
  return `Too many attempts. Try again in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`
}

/** The caller's public IP. Vercel overwrites `x-forwarded-for` at its edge and drops any value
 *  the client sent, so it is trustworthy there. Absent locally, where every caller shares one
 *  'unknown' bucket — fine for a dev machine. */
export function clientIp(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || headers.get('x-real-ip') || 'unknown'
}

/** Drop windows that have ended. Called from the daily cron. */
export async function purgeExpiredWindows(now = new Date()): Promise<number> {
  const gone = await db.delete(rateLimits).where(lt(rateLimits.expiresAt, now)).returning({ key: rateLimits.key })
  return gone.length
}
