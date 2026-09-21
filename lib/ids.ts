// Format checks for identifiers that arrive from a URL, a request body or a server-action
// argument. Postgres does not answer a malformed one with "no rows": a non-uuid against a
// uuid column is error 22P02, and a NUL byte in any text parameter is 22021. Either one
// turns a lookup that should have said 404 into a 500. Every lookup that takes one of these
// from outside checks it first and treats a bad one exactly like a missing row.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Any hyphenated uuid, regardless of version, since Postgres accepts all of them. */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

/** The 6-digit room PIN, as newCode() issues it. */
export function isRoomCode(v: unknown): v is string {
  return typeof v === 'string' && /^\d{6}$/.test(v)
}

/** A share-link token: base64url, as setDeckShared mints it. Length is a ceiling rather than
 *  the exact 22, so a token minted some other way later still resolves. */
export function isShareToken(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}
