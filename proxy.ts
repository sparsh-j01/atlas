import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

// Next 16 renamed the `middleware` file convention to `proxy` (same request-interception
// role). Here it refreshes the Supabase session cookie + gates the creator area — see
// lib/supabase/middleware.ts (updateSession).
export async function proxy(request: NextRequest) {
  // A path Next can't percent-decode (`/api/sessions/%ff/join`) fails inside its own router
  // as a bare 500 before any handler runs, so it is refused here, where it can still be a 400.
  try {
    decodeURIComponent(request.nextUrl.pathname)
  } catch {
    return Response.json({ error: 'malformed URL' }, { status: 400 })
  }
  return await updateSession(request)
}

export const config = {
  // Everything except static assets; the creator gate lives in updateSession.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
}
