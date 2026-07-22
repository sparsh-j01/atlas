import 'server-only'
import { randomInt, randomUUID } from 'node:crypto'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sessions } from '@/lib/db/schema'

/** 6-digit PIN as a zero-padded string. Uniqueness among live sessions is enforced by
 *  the partial unique index; the start endpoint retries on the rare collision. */
export function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** Opaque server-issued token (participant reconnect / host authorization). */
export function newToken(): string {
  return randomUUID()
}

export async function findLiveSession(code: string) {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.code, code), ne(sessions.status, 'ended')))
    .limit(1)
  return rows[0] ?? null
}

/** Postgres unique-violation (SQLSTATE 23505), surfaced through postgres.js. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === '23505'
}

export function bad(status: number, error: string): Response {
  return Response.json({ error }, { status })
}
