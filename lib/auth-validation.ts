import { z } from 'zod'

/**
 * Shapes for everything the auth screens and routes accept.
 *
 * What this file is NOT: password hashing. Supabase Auth bcrypts the password on its own
 * servers and this app never sees a stored credential — there is nothing here to hash.
 * Hashing in the browser would make the hash the password: it would be replayable
 * straight from a leaked database, and it would throw away the server's work factor.
 * The password's protection in transit is TLS, and at rest it is Supabase's bcrypt.
 *
 * Two of these schemas guard a real trust boundary (the query parameters on
 * `/auth/confirm`, which anyone can type); the form schemas are there to give a person a
 * useful error before the round trip. Supabase re-checks everything regardless — client
 * validation is a courtesy, never the gate.
 */

// 254 is the practical maximum length of an email address (RFC 5321's envelope limit).
export const emailSchema = z
  .string()
  .trim()
  .min(1, 'Enter your email address.')
  .max(254, 'That email address is too long.')
  .pipe(z.email('That does not look like an email address.'))

/**
 * 8 is our floor, above Supabase's default of 6. 72 is bcrypt's: it hashes the first 72
 * bytes and silently ignores the rest, so a longer password would be a promise the
 * algorithm does not keep.
 */
export const newPasswordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(72, 'Use at most 72 characters.')

/** Signing in only asks that something was typed. The strength rule belongs where the
 *  password is chosen — applying it here would lock out an account created under an older,
 *  shorter rule, and the server is the one that decides anyway. */
export const currentPasswordSchema = z.string().min(1, 'Enter your password.')

export const signUpSchema = z.object({ email: emailSchema, password: newPasswordSchema })
export const signInSchema = z.object({ email: emailSchema, password: currentPasswordSchema })

/**
 * Where a link may send someone after it verifies: a path on this origin, and nothing
 * else. `//host` and `/\host` are the two that look relative and are not — browsers read
 * both as protocol-relative URLs to another site, which is an open redirect and, on an
 * auth route, a phishing page wearing our domain. Anything unparseable falls back to the
 * dashboard rather than erroring; a bad `next` is not a reason to strand a verified user.
 */
export const nextPathSchema = z
  .string()
  .transform((value) => {
    const origin = 'https://redirect.invalid'
    // Reject browser-normalized control characters and backslashes before parsing.
    // Also reject their encoded forms so another decode cannot turn a safe path into a host.
    if (!value.startsWith('/') || /[\u0000-\u0020\u007f\\]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value))
      return '/dashboard'
    try {
      const url = new URL(value, origin)
      if (url.origin !== origin || url.pathname.startsWith('//')) return '/dashboard'
      return `${url.pathname}${url.search}${url.hash}`
    } catch {
      return '/dashboard'
    }
  })
  .catch('/dashboard')

/** The email link's own parameters. `type` is an allowlist because it is passed straight to
 *  verifyOtp, and `token_hash` is bounded so a multi-megabyte query string is refused here
 *  rather than in the auth server. */
export const confirmParamsSchema = z.object({
  token_hash: z.string().min(1).max(512),
  type: z.enum(['signup', 'recovery', 'email_change', 'magiclink', 'email', 'invite']),
  next: nextPathSchema,
})

/** First message from a failed parse — the forms show one error at a time. */
export function firstError(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Check the details and try again.'
}

/**
 * Social sign-in providers this app offers. An allowlist, not a passthrough: the value
 * reaches `signInWithOAuth` and from there the authorize URL, so an unchecked parameter
 * would let anyone point our sign-in button at any provider the Supabase project has ever
 * had configured. One entry today — adding Microsoft is this line plus a dashboard app.
 */
export const oauthProviderSchema = z.enum(['google'])

/** `/auth/signin` query parameters. `next` reuses the same same-origin guard as the email
 *  links; there is one redirect rule in this app and this is it. */
export const oauthSignInParamsSchema = z.object({
  provider: oauthProviderSchema,
  next: nextPathSchema,
})

/**
 * The origin the auth routes redirect to. Not `new URL(request.url).origin`: under `next dev`
 * Next builds request.url from the address the server was started with (`localhost`), so a
 * teacher signed in at the laptop's network IP was sent back to localhost, where the PKCE
 * cookie isn't. The Host header is the address the browser actually used. On Vercel
 * request.url is already built from Host, so this changes nothing there. A forged Host moves
 * no real login: browsers don't let pages set it, and Supabase's redirect allowlist still
 * checks redirect_to. An unparseable Host is ignored by the URL setter.
 */
export function requestOrigin(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('host')
  if (host) url.host = host
  return url.origin
}
