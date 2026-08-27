import 'server-only'
import { randomInt, randomUUID } from 'node:crypto'
import { cookies } from 'next/headers'
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

/** The host's capability token for `code`, as the control routes (advance/reveal/end)
 *  receive it. The httpOnly cookie the launch set — the browser attaches it
 *  automatically, so the token never touches client JS, and `SameSite=Lax` keeps a
 *  cross-site POST from carrying it (no CSRF token needed). */
export async function hostTokenFrom(req: Request, code: string): Promise<string> {
  // In production, only accept the httpOnly cookie. Bearer token fallback is only for tests.
  if (process.env.NODE_ENV !== 'production') {
    const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
    if (bearer) return bearer
  }
  return (await cookies()).get(`htk_${code}`)?.value ?? ''
}

/** Postgres unique-violation (SQLSTATE 23505), surfaced through postgres.js. Pass a
 *  constraint/index name when the caller needs to tell two unique indexes apart — a session
 *  insert can trip either the live-code index or the one-room-per-deck index, and they call
 *  for opposite responses (retry vs. resume the existing room). */
export function isUniqueViolation(e: unknown, constraint?: string): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e)) return false
  const err = e as { code: unknown; constraint_name?: unknown }
  if (err.code !== '23505') return false
  return constraint === undefined || err.constraint_name === constraint
}

export function bad(status: number, error: string): Response {
  return Response.json({ error }, { status })
}
