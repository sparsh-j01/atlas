import { NextResponse } from 'next/server'
import { nextPathSchema } from '@/lib/auth-validation'
import { createClient } from '@/lib/supabase/server'

// Where the PKCE authorization code comes back — from Supabase's default email templates,
// and from social sign-in started at ../signin. Both legs are the same Authorization Code
// + PKCE exchange, so they share one route.
//
// The code alone is not enough to get a session: exchangeCodeForSession sends it with the
// code_verifier from this browser's cookie. That is what closes authorization-code
// injection and login CSRF — a code obtained in the attacker's browser cannot be redeemed
// in the victim's, because the verifier that matches it never left the attacker's cookie jar.
//
// Links that carry a `token_hash` instead go to ../confirm, which is the path that also
// works when the mail is opened on a different device.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  // Same guard as ../confirm, from the same schema: a same-origin path or the dashboard.
  const next = nextPathSchema.parse(searchParams.get('next'))

  // The provider can answer with an error instead of a code (consent declined, app
  // misconfigured). Say so in our own words — the raw description is provider-controlled
  // text and does not belong reflected on our page.
  const providerError = searchParams.get('error')
  if (providerError) {
    return NextResponse.redirect(
      `${origin}/login?error=${providerError === 'access_denied' ? 'denied' : 'oauth'}`,
    )
  }

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    // A replayed, tampered or expired code fails here and lands on the login page with no
    // session — the exchange is single-use at the auth server.
    if (!error) return NextResponse.redirect(`${origin}${next}`)
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}
