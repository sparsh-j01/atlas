import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

// Next 16 renamed the `middleware` file convention to `proxy` (same request-interception
// role). Here it refreshes the Supabase session cookie + gates the creator area — see
// lib/supabase/middleware.ts (updateSession).
export async function proxy(request: NextRequest) {
  return await updateSession(request)
}

export const config = {
  // Everything except static assets; the creator gate lives in updateSession.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
