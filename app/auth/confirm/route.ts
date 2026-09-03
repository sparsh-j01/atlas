import { NextResponse } from 'next/server'
import { confirmParamsSchema } from '@/lib/auth-validation'
import { createClient } from '@/lib/supabase/server'

// Where the emailed links land: ?token_hash=...&type=signup|recovery|email_change.
//
// verifyOtp, not the PKCE code exchange in ../callback: the code verifier lives in the
// cookies of the browser that asked for the email, and a teacher who signs up on a laptop
// and opens the mail on their phone has none. A token hash verifies anywhere.
// Set the Supabase email templates to point here — see README, "Auth setup".
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url)

  // Anyone can type this URL, so nothing in it is trusted: `type` is an allowlist (it goes
  // straight to verifyOtp), and `next` is forced back to a path on this origin, which is
  // what stops a confirmation link from bouncing a just-verified teacher onto someone
  // else's page. See lib/auth-validation.ts.
  const params = confirmParamsSchema.safeParse({
    token_hash: searchParams.get('token_hash'),
    type: searchParams.get('type'),
    next: searchParams.get('next'),
  })

  if (params.success) {
    const supabase = await createClient()
    const { error } = await supabase.auth.verifyOtp({
      type: params.data.type,
      token_hash: params.data.token_hash,
    })
    if (!error) return NextResponse.redirect(`${origin}${params.data.next}`)
  }

  return NextResponse.redirect(`${origin}/login?error=link`)
}
