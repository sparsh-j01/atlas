import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Magic-link lands here with a `code`; exchange it for a session cookie, then continue.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') ?? '/dashboard'

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      // Only allow same-origin relative redirects (never an attacker-supplied absolute URL).
      const dest = next.startsWith('/') ? next : '/dashboard'
      return NextResponse.redirect(`${origin}${dest}`)
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}
