import { NextResponse } from 'next/server'
import { oauthSignInParamsSchema } from '@/lib/auth-validation'
import { createClient } from '@/lib/supabase/server'

// Starts a social sign-in. The whole OAuth 2.0 / OIDC exchange belongs to Supabase Auth:
// it holds the Google client secret, builds the authorize URL, and validates the ID token
// (signature, issuer, audience, nonce, expiry) on its own servers. This app is the OAuth
// client OF Supabase, not of Google — which is why there is no crypto, no JWT parsing and
// no token handling anywhere in this file. Do not add any.
//
// Server-initiated rather than a browser `signInWithOAuth()` call, for three reasons:
// the PKCE code verifier is written by the server's cookie adapter instead of by page JS,
// the provider is checked against an allowlist before it reaches the authorize URL, and
// `redirect_to` is built from this request's origin rather than from a value the page
// hands us.
//
// GET, not POST: this is a plain top-level navigation from an <a>, so CSP's
// `form-action 'self'` never has to weigh in on the cross-origin hop to Google. Starting a
// flow is not a state change worth protecting — login CSRF is stopped at the other end,
// where /auth/callback will only exchange a code against the verifier cookie held by the
// browser that began this request.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)

  const params = oauthSignInParamsSchema.safeParse({
    provider: searchParams.get('provider'),
    next: searchParams.get('next'),
  })
  if (!params.success) return NextResponse.redirect(`${origin}/login?error=provider`)

  const supabase = await createClient()
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: params.data.provider,
    options: {
      // Exact URI — no wildcard, no path built from user input. It must also be listed in
      // the Supabase dashboard's redirect allowlist, which is the check that holds even if
      // this origin were ever spoofed via a forged Host header.
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(params.data.next)}`,
      // Least privilege: enough to identify the teacher and seed `profiles`, nothing more.
      // No Classroom, Drive or Calendar scope — this app reads nothing from Google.
      scopes: 'openid email profile',
      // Hand back the URL instead of redirecting the fetch; we issue the 302 ourselves.
      skipBrowserRedirect: true,
    },
  })

  // Fail closed. A misconfigured provider must land on the login page, never on a
  // half-built authorize URL.
  if (error || !data?.url) return NextResponse.redirect(`${origin}/login?error=oauth`)

  return NextResponse.redirect(data.url)
}
