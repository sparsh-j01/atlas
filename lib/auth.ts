import 'server-only'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'

/** The authed creator, or a redirect to /login. Use in creator pages + server actions —
 *  never trust the middleware gate alone for a write. */
export async function requireUser() {
  const user = await getAuthUser()
  if (!user) redirect('/login')
  return user
}

/** The authed creator or null — no redirect. For JSON route handlers where a signed-out
 *  caller wants a 401 body, not an HTML login page their fetch would silently follow. */
export async function getAuthUser() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  return user
}
