'use client'

import { Suspense, useState, useTransition } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import {
  type AuthResult,
  requestPasswordResetAction,
  resendConfirmationAction,
  signInAction,
  signUpAction,
} from '@/lib/auth-actions'
import { SiteHeader } from '@/components/SiteHeader'
import { btn, capCls, inputCls } from '@/components/ui'

// Codes set by /auth/signin and /auth/callback. Mapped to our own copy here so the page
// never renders a message that came from the provider's error response.
const AUTH_ERRORS: Record<string, string> = {
  denied: 'Google sign-in was cancelled.',
  oauth: 'Google sign-in did not finish. Try again, or use your email and password.',
  provider: 'That sign-in method is not available.',
}

function authError(code: string | null): string | null {
  if (!code) return null
  return AUTH_ERRORS[code] ?? 'That link expired or was already used. Try again.'
}

/** Google's mark, inline: the CSP allows no third-party images, and a brand button with a
 *  broken icon reads as a broken button. aria-hidden — the label beside it already says it. */
function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="h-[18px] w-[18px]" aria-hidden focusable="false">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 2-1.6 5-4.5 7l-.1.3 6.5 5 .5.1c4.2-3.8 6.6-9.5 6.6-15.7" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-1.9 14.5-5.3l-6.9-5.4c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.8-12.5-9l-.3.1-6.7 5.2-.1.3C8 42.2 15.4 46 24 46" />
      <path fill="#FBBC05" d="M11.5 28.5c-.5-1.4-.7-2.9-.7-4.5s.3-3.1.7-4.5v-.3l-6.8-5.3-.2.1C2.9 17.1 2 20.4 2 24s.9 6.9 2.5 9.9z" />
      <path fill="#EA4335" d="M24 9.5c4.1 0 6.9 1.8 8.5 3.3l6.2-6C34.9 3.4 29.9 1 24 1 15.4 1 8 5.8 4.5 13.1l7 5.4c1.8-5.2 6.7-9 12.5-9" />
    </svg>
  )
}

function LoginForm() {
  const params = useSearchParams()
  const next = params.get('next') ?? '/dashboard'
  // The landing and pricing CTAs say "create", so they arrive with ?mode=signup and get the
  // create-account form rather than a sign-in form they have to notice the toggle under.
  const [mode, setMode] = useState<'signin' | 'signup'>(
    params.get('mode') === 'signup' ? 'signup' : 'signin',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // 'verify' after signup, 'reset' after a password-reset request. Both are "go read your
  // email" screens; nothing else in this component has a success state.
  const [done, setDone] = useState<null | 'verify' | 'reset'>(null)
  const [error, setError] = useState<string | null>(authError(params.get('error')))
  const [needsConfirm, setNeedsConfirm] = useState(false)
  const [busy, startTransition] = useTransition()

  // Every handler ends here. The password and the validation both live on the server now
  // (lib/auth-actions.ts) — this component never holds a token and never sees a session.
  function apply(result: AuthResult) {
    if (result.redirectTo) {
      // A full load, not router.push: the session cookie is httpOnly and set on the action's
      // response, and the creator area is gated in proxy.ts, which only sees it on a real
      // request.
      window.location.assign(result.redirectTo)
      return
    }
    setNeedsConfirm(Boolean(result.needsConfirm))
    setError(result.error ?? null)
    if (result.done) setDone(result.done)
  }

  function run(action: () => Promise<AuthResult>) {
    setError(null)
    setNeedsConfirm(false)
    startTransition(async () => apply(await action()))
  }

  // FormData, not plain arguments: `next dev` prints an action's positional arguments to
  // the terminal, password included. See lib/auth-actions.ts.
  function credentials() {
    const form = new FormData()
    form.set('email', email)
    form.set('password', password)
    form.set('next', next)
    return form
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    run(() =>
      mode === 'signup' ? signUpAction(credentials()) : signInAction(credentials()),
    )
  }

  // Same column width and heading position as the form, so confirming does not shift the
  // page under the reader.
  if (done) {
    return (
      <div className="w-full max-w-sm">
        <h1 className="font-display text-[40px] leading-none">Check your email</h1>
        <p className="mt-4 leading-relaxed text-dim">
          {done === 'verify' ? 'A confirmation link is on its way to ' : 'A reset link is on its way to '}
          <span className="tabular text-ink">{email}</span>.{' '}
          {done === 'verify'
            ? 'Click it and you are signed in. It expires in 24 hours.'
            : 'It works once, and it expires in an hour.'}
        </p>
        <p className="mt-4 text-sm text-dim">
          Nothing after a minute or two? Check spam — and note the demo sender is rate
          limited to a couple of emails an hour.
        </p>
        <button
          onClick={() => {
            setDone(null)
            setPassword('')
          }}
          className={`${btn('ghost', 'sm')} mt-6 -ml-3.5`}
        >
          Back to sign in
        </button>
      </div>
    )
  }

  const signup = mode === 'signup'

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-6">
      <div>
        <h1 className="font-display text-[40px] leading-none">
          {signup ? 'Create an account' : 'Sign in'}
        </h1>
        <p className="mt-3 text-dim">
          {signup
            ? 'We email you a link to confirm the address, then you are in.'
            : 'Teachers only. Students join a class with a room code.'}
        </p>
      </div>

      {/* Plain <a>, not <Link>: this href is a route handler that sets the PKCE verifier
          cookie and redirects to Google, so a router prefetch would silently start an OAuth
          flow on hover. A navigation also keeps CSP's `form-action 'self'` out of the
          cross-origin hop, which a form submission would have to satisfy. */}
      <a
        href={`/auth/signin?provider=google&next=${encodeURIComponent(next)}`}
        rel="nofollow"
        className={btn('secondary', 'lg')}
      >
        <GoogleMark />
        Continue with Google
      </a>

      <div className="flex items-center gap-4 text-sm text-dim" aria-hidden>
        <span className="h-px flex-1 bg-rule" />
        or
        <span className="h-px flex-1 bg-rule" />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="email" className={capCls}>
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'form-error' : undefined}
          placeholder="you@university.edu"
          className={`${inputCls} w-full`}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="password" className={capCls}>
          Password
        </label>
        <input
          id="password"
          type="password"
          required
          minLength={signup ? 8 : undefined}
          autoComplete={signup ? 'new-password' : 'current-password'}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={signup ? 'password-hint' : error ? 'form-error' : undefined}
          className={`${inputCls} w-full`}
        />
        {signup && (
          <p id="password-hint" className="text-sm text-dim">
            At least 8 characters.
          </p>
        )}
      </div>

      {error && (
        <p id="form-error" role="alert" className="-mt-2 text-sm text-wrong">
          {error}
          {needsConfirm && (
            <>
              {' '}
              <button
                type="button"
                onClick={() => run(() => resendConfirmationAction(email, next))}
                className="font-semibold underline"
              >
                Send the link again
              </button>
            </>
          )}
        </p>
      )}

      <button type="submit" disabled={busy || !email || !password} className={btn('primary', 'lg')}>
        {busy ? 'Working' : signup ? 'Create account' : 'Sign in'}
      </button>

      <div className="flex flex-col gap-2 text-sm text-dim">
        <p>
          {signup ? 'Already have an account? ' : 'New here? '}
          <button
            type="button"
            onClick={() => {
              setMode(signup ? 'signin' : 'signup')
              setError(null)
              setNeedsConfirm(false)
            }}
            className="font-semibold text-pen-ink hover:underline"
          >
            {signup ? 'Sign in' : 'Create an account'}
          </button>
        </p>

        {!signup && (
          <p>
            Forgot your password?{' '}
            <button
              type="button"
              onClick={() => run(() => requestPasswordResetAction(email))}
              disabled={busy}
              className="font-semibold text-pen-ink hover:underline disabled:opacity-40"
            >
              Email me a reset link
            </button>
          </p>
        )}

        <p>
          Joining a class instead?{' '}
          <Link href="/play" className="font-semibold text-pen-ink hover:underline">
            Enter a room code
          </Link>
          .
        </p>
      </div>
    </form>
  )
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main
        id="main"
        className="mx-auto flex w-full max-w-5xl flex-1 items-center gap-16 px-6 py-16"
      >
        <Suspense>
          <LoginForm />
        </Suspense>

        {/* The product's one sticky note, carrying the actual proposition rather than
            decorating. Hidden on small screens, where the form is the whole page. */}
        <aside className="hidden flex-1 justify-center lg:flex" aria-hidden>
          <p className="sticky-note !text-[26px]">
            <strong>Your material.</strong>
            <br />
            Your questions.
            <br />
            Your classroom. <u>Live.</u>
          </p>
        </aside>
      </main>
    </div>
  )
}
