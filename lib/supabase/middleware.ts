import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from './cookie-options'

// Refreshes the auth cookie on every request (Supabase SSR: without this, server
// components can see an expired session) and gates the creator area. Not `server-only`
// — middleware runs in its own runtime and imports only client-safe env.
// Every prefix under app/(creator). The real gate is requireUser() in the layout and in each
// action — this list only buys the signed-out visitor a redirect that remembers where they
// were going (`?next=`), instead of a bare bounce to /login from the server component.
//
// `/d` is deliberately absent: a shared deck is public by design, and gating it here would
// send every recipient of a share link to a sign-in page.
const CREATOR_PREFIXES = ['/dashboard', '/decks', '/results', '/usage']

export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request })

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // Must match ./server.ts exactly, or a refresh here rewrites the cookie with weaker
    // attributes than the one sign-in set.
    cookieOptions: SESSION_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return request.cookies.getAll()
      },
      setAll(cookiesToSet, headers) {
        for (const { name, value } of cookiesToSet) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options)
        // On token refresh Supabase sends no-store/private cache headers — forward them so a
        // CDN can't cache this authenticated response and serve one user's session to another.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value)
      },
    },
  })

  // getClaims(), not getUser(): this runs on EVERY request, host-console actions mid-game
  // included, and getUser() is a round trip to Supabase Auth each time. This project signs
  // sessions with an asymmetric key (ES256, checked 2026-10-04), so getClaims() verifies the
  // signature locally against the cached JWKS — no network call — and still refreshes an
  // expired token on the way (the cookie write in setAll above). On an HS256 token it falls
  // back to getUser() by itself, so a key rotation back to symmetric costs speed, not safety.
  // What it gives up: a session revoked server-side still passes HERE until it expires (≤1h).
  // That is fine because this is only the redirect hint; requireUser() still calls getUser().
  const { data } = await supabase.auth.getClaims()
  const signedIn = Boolean(data?.claims)

  const path = request.nextUrl.pathname
  if (!signedIn && CREATOR_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  return response
}
