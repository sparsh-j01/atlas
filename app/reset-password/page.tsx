'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { updatePasswordAction } from '@/lib/auth-actions'
import { SiteHeader } from '@/components/SiteHeader'
import { btn, capCls, inputCls } from '@/components/ui'

/**
 * Where the reset link lands after /auth/confirm has verified it — that verification is
 * what puts a session on this request, and the session is the whole authorisation for the
 * change below.
 *
 * There is no session check on mount: without one, updateUser fails and says so, which is
 * the same outcome as a check with one fewer round trip and no flash of a form that was
 * never going to work.
 *
 * The update runs server-side (lib/auth-actions.ts) so the recovery session cookie can stay
 * httpOnly — this page never reads it and never holds a token.
 */
export default function ResetPassword() {
  const [password, setPassword] = useState('')
  const [busy, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    startTransition(async () => {
      // The action holds the rule (same schema as signup — a password set here is a new
      // one) and the recovery session. This side only routes the answer.
      // FormData so the new password stays out of the dev server's action log.
      const form = new FormData()
      form.set('password', password)
      const result = await updatePasswordAction(form)
      if (result.redirectTo) {
        // Full load, not router.push: the refreshed cookie has to reach proxy.ts.
        window.location.assign(result.redirectTo)
        return
      }
      setError(result.error ?? null)
    })
  }

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto flex w-full max-w-5xl flex-1 items-center px-6 py-16">
        <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-6">
          <div>
            <h1 className="font-display text-[40px] leading-none">Set a new password</h1>
            <p className="mt-3 text-dim">This signs you in on this device.</p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="password" className={capCls}>
              New password
            </label>
            <input
              id="password"
              type="password"
              required
              autoFocus
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'reset-error' : 'password-hint'}
              className={inputCls}
            />
            <p id="password-hint" className="text-sm text-dim">
              At least 8 characters.
            </p>
          </div>

          {error && (
            <p id="reset-error" role="alert" className="-mt-2 text-sm text-wrong">
              {error}{' '}
              <Link href="/login" className="font-semibold underline">
                Back to sign in
              </Link>
            </p>
          )}

          <button type="submit" disabled={busy || !password} className={btn('primary', 'lg')}>
            {busy ? 'Saving' : 'Save password'}
          </button>
        </form>
      </main>
    </div>
  )
}
