import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from './cookie-options'

// Refreshes the auth cookie on every request (Supabase SSR: without this, server
// components can see an expired session) and gates the creator area. Not `server-only`
// — middleware runs in its own runtime and imports only client-safe env.
const CREATOR_PREFIXES = ['/dashboard', '/decks']

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

  // getUser() (not getSession) revalidates the token against Supabase — the refresh.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const path = request.nextUrl.pathname
  if (!user && CREATOR_PREFIXES.some((p) => path === p || path.startsWith(p + '/'))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.searchParams.set('next', path)
    return NextResponse.redirect(url)
  }

  return response
}
