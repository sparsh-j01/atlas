import 'server-only'
import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '@/lib/env'
import { SESSION_COOKIE_OPTIONS } from './cookie-options'

// Request-scoped client bound to the caller's cookies (authed creators in server
// components / route handlers). Next 16: cookies() is async.
export async function createClient() {
  const cookieStore = await cookies()
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // httpOnly + secure — see ./cookie-options.ts for why the library's defaults aren't.
    cookieOptions: SESSION_COOKIE_OPTIONS,
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options)
          }
        } catch {
          // Called from a Server Component (read-only cookies). Safe to ignore when
          // session refresh happens in middleware.
        }
      },
    },
  })
}
