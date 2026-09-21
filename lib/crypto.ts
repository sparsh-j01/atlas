import { timingSafeEqual } from 'node:crypto'

export async function sha256(input: string | Buffer): Promise<string> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** String equality that takes the same time wherever the first difference is, for comparing
 *  a caller-supplied secret. The length check leaks only the length. */
export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/** True when `authorization` is exactly `Bearer <secret>`. An unset or empty secret matches
 *  nothing, so a missing env var disables the route instead of opening it. */
export function bearerMatches(authorization: string | null, secret: string | undefined): boolean {
  if (!secret) return false
  return constantTimeEqual(authorization ?? '', `Bearer ${secret}`)
}
