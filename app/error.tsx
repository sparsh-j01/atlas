'use client'

import Link from 'next/link'
import { btn } from '@/components/ui'

/**
 * The app-wide error boundary — everything except the host console, which has its own
 * (`app/host/[code]/error.tsx`) because that one renders on a wall.
 *
 * There was no boundary anywhere before this, so any server error on a creator screen was
 * Next's default page in the framework's own typography, outside the design system.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <div>
        <h1 className="font-display text-[44px] leading-none">That did not load</h1>
        <p className="mt-3 text-dim">
          Something went wrong on our side. Nothing you had saved is affected.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <button onClick={() => retry()} className={btn('primary', 'lg')}>
          Try again
        </button>
        <Link href="/dashboard" className={btn('secondary', 'lg')}>
          Your decks
        </Link>
      </div>
      {error.digest && <p className="text-sm text-dim">Reference {error.digest}</p>}
    </main>
  )
}
