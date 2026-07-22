'use client'

import { Suspense, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

function LoginForm() {
  const params = useSearchParams()
  const next = params.get('next') ?? '/dashboard'
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(params.get('error') ? 'Sign-in link expired — try again.' : null)
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
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="mt-2 text-neutral-500">
          We sent a sign-in link to <span className="font-medium text-neutral-800 dark:text-neutral-200">{email}</span>.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="flex w-full max-w-sm flex-col gap-4">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Sign in</h1>
        <p className="mt-1 text-sm text-neutral-500">We&apos;ll email you a magic link — no password.</p>
      </div>
      <input
        type="email"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="rounded-lg border border-neutral-300 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-900"
      />
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-indigo-600 px-4 py-3 font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Sending…' : 'Send magic link'}
      </button>
    </form>
  )
}

export default function LoginPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center p-8">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  )
}
