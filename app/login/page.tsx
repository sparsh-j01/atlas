'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { btn, capCls, inputCls } from '@/components/ui'

function LoginForm() {
  const params = useSearchParams()
  const next = params.get('next') ?? '/dashboard'
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(
    params.get('error') ? 'That sign-in link expired. Request a new one.' : null,
  )
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const supabase = createClient()
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo } })
    setBusy(false)
    if (error) setError(error.message)
    else setSent(true)
  }

  if (sent) {
    return (
      <div className="w-full max-w-sm">
        <h1 className="font-display text-3xl">Check your email</h1>
        <p className="mt-3 leading-relaxed text-dim">
          A sign-in link is on its way to{' '}
          <span className="font-data text-ink">{email}</span>. It works once, and it expires
          in an hour.
        </p>
        <button onClick={() => setSent(false)} className={`${btn('ghost', 'sm')} mt-6 -ml-3`}>
          Use a different address
        </button>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-5">
      <div>
        <h1 className="font-display text-3xl">Sign in</h1>
        <p className="mt-2 text-dim">No password. We email you a link that signs you in.</p>
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor="email" className={capCls}>
          Email
        </label>
        <input
          id="email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'email-error' : undefined}
          placeholder="you@university.edu"
          className={inputCls}
        />
        {error && (
          <p id="email-error" role="alert" className="text-sm text-wrong">
            {error}
          </p>
        )}
      </div>

      <button type="submit" disabled={busy || !email} className={btn('primary', 'lg')}>
        {busy ? 'Sending' : 'Send the link'}
      </button>

      <p className="text-sm text-dim">
        Joining a class instead?{' '}
        <Link href="/play" className="text-lamp hover:underline">
          Enter a room code
        </Link>
        .
      </p>
    </form>
  )
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col">
      <div className="border-b border-rule px-6 py-5 lg:px-10">
        <Link href="/" className="font-display text-xl">
          Atlas
        </Link>
      </div>
      <div className="flex flex-1 items-center justify-center p-6">
        <Suspense>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  )
}
