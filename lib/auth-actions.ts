'use server'

import { headers } from 'next/headers'
import {
  emailSchema,
  firstError,
  newPasswordSchema,
  nextPathSchema,
  signInSchema,
  signUpSchema,
} from '@/lib/auth-validation'
import { createClient } from '@/lib/supabase/server'

/**
 * Every auth call that used to run in the browser.
 *
 * Why it moved. `@supabase/ssr` defaults to `httpOnly: false` (its own
 * DEFAULT_COOKIE_OPTIONS) because a browser Supabase client has to be able to read the
 * session it just wrote. That makes the teacher's access AND refresh token readable by any
 * script on the page — one XSS and an attacker walks away with a refresh token, not just a
 * ride on the current session. Doing these five calls on the server instead means the
 * session cookie is only ever written by a server response, so it can be `httpOnly` and
 * `secure` (set in lib/supabase/server.ts and lib/supabase/middleware.ts) and page JS never
 * touches a token at all.
 *
 * Nothing in the browser needs the session any more: the realtime channels authorize
 * through RLS policies granted to `anon, authenticated` alike (migration 0005), so the host
 * console keeps working with the anon key.
 *
 * These are POST endpoints reachable by anyone who can send the request, so validation here
 * is a real gate, not the courtesy it was on the client. Next checks `Origin` against
 * `Host` before an action runs, which is the CSRF control.
 *
 * The three actions that carry a password take FormData rather than positional strings.
 * `next dev` prints every server action's arguments to the terminal — `signInAction("a@b.c",
 * "hunter2", "/dashboard")` — so plain parameters put real passwords into scrollback and into
 * any CI job that captures dev output. FormData arguments are not expanded. Production never
 * logged them either way; this is about the developer's own terminal. The two email-only
 * actions keep plain parameters, since an address in a local log is not a credential.
 */

export type AuthResult = {
  error?: string
  /** 'verify' after signup, 'reset' after a reset request — both are "go read your email". */
  done?: 'verify' | 'reset'
  /** The account exists and the password was right; the link was never clicked. */
  needsConfirm?: boolean
  /** Where the caller should send the browser on success. */
  redirectTo?: string
}

/** This deployment's origin. Next has already compared this header to Host by the time an
 *  action body runs, so it is safe to build an email link from. */
async function origin(): Promise<string> {
  const h = await headers()
  return h.get('origin') ?? `https://${h.get('host') ?? ''}`
}

const confirmUrl = async (next: string) =>
  `${await origin()}/auth/confirm?next=${encodeURIComponent(next)}`

export async function signUpAction(form: FormData): Promise<AuthResult> {
  const parsed = signUpSchema.safeParse({
    email: String(form.get('email') ?? ''),
    password: String(form.get('password') ?? ''),
  })
  if (!parsed.success) return { error: firstError(parsed.error) }

  const supabase = await createClient()
  const { error } = await supabase.auth.signUp({
    ...parsed.data,
    options: {
      emailRedirectTo: await confirmUrl(nextPathSchema.parse(form.get('next'))),
    },
  })
  // No branch on "user already exists": Supabase deliberately returns the same shape for a
  // taken address, and telling them apart here would turn this form into a way to test
  // whether a colleague has an account.
  return error ? { error: error.message } : { done: 'verify' }
}

export async function signInAction(form: FormData): Promise<AuthResult> {
  const email = String(form.get('email') ?? '')
  const password = String(form.get('password') ?? '')
  const next = String(form.get('next') ?? '')
  const parsed = signInSchema.safeParse({ email, password })
  if (!parsed.success) return { error: firstError(parsed.error) }

  const supabase = await createClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)
  // The session cookie is written by this response, httpOnly — the caller only gets a path.
  if (!error) return { redirectTo: nextPathSchema.parse(next) }

  // The one error worth handling specially. Anything else keeps Supabase's own wording.
  if (/confirm/i.test(error.message)) {
    return { needsConfirm: true, error: 'This account still needs its email confirmed.' }
  }
  return { error: error.message }
}

export async function resendConfirmationAction(email: string, next: string): Promise<AuthResult> {
  const parsed = emailSchema.safeParse(email)
  if (!parsed.success) return { error: firstError(parsed.error) }

  const supabase = await createClient()
  await supabase.auth.resend({
    type: 'signup',
    email: parsed.data,
    options: { emailRedirectTo: await confirmUrl(nextPathSchema.parse(next)) },
  })
  return { done: 'verify' }
}

export async function requestPasswordResetAction(email: string): Promise<AuthResult> {
  const parsed = emailSchema.safeParse(email)
  if (!parsed.success) return { error: firstError(parsed.error) }

  const supabase = await createClient()
  await supabase.auth.resetPasswordForEmail(parsed.data, {
    redirectTo: `${await origin()}/auth/confirm?next=/reset-password`,
  })
  // Sent or not, the same answer: whether an address has an account is not ours to tell.
  return { done: 'reset' }
}

/** Sets a new password using the recovery session /auth/confirm put on this browser. That
 *  session IS the authorisation — there is nothing else to check. */
export async function updatePasswordAction(form: FormData): Promise<AuthResult> {
  const parsed = newPasswordSchema.safeParse(String(form.get('password') ?? ''))
  if (!parsed.success) return { error: firstError(parsed.error) }

  const supabase = await createClient()
  const { error } = await supabase.auth.updateUser({ password: parsed.data })
  if (!error) return { redirectTo: '/dashboard' }

  return {
    error: /session|logged|auth/i.test(error.message)
      ? 'This reset link expired or was already used. Ask for a new one.'
      : error.message,
  }
}
