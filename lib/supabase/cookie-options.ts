/**
 * Attributes for the Supabase session cookie, applied everywhere a SERVER response writes
 * it (./server.ts and ./middleware.ts). Not `server-only` — middleware runs in its own
 * runtime and this file holds no secret.
 *
 * @supabase/ssr's own DEFAULT_COOKIE_OPTIONS are `httpOnly: false` with no `secure` key at
 * all, because its *browser* client has to read the session back out of document.cookie.
 * That leaves the access and refresh token exposed to any script on the page. Nothing in
 * this app's browser reads the session — every auth call runs server-side in
 * lib/auth-actions.ts, and the realtime channels authorize fine as `anon` (migration 0005)
 * — so both can be closed.
 *
 * `sameSite: 'lax'`, not 'strict': the return leg of an OAuth sign-in is a top-level
 * cross-site GET from the provider, and Strict would withhold the PKCE verifier cookie on
 * exactly that request, breaking every social login.
 *
 * `maxAge` is deliberately absent — @supabase/ssr overrides it with its own 400-day value
 * regardless of what is passed here. The cookie's lifetime is not the session's: the access
 * token inside expires in an hour and the refresh token rotates.
 */
export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  // Conditional, not a literal `true`, or the cookie is dropped on http://localhost and
  // nobody can sign in locally. Same rule as the host token in lib/actions.ts.
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  path: '/',
} as const
