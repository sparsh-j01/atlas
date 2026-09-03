import Link from 'next/link'
import { btn } from '@/components/ui'

/**
 * Reached when `getHostedSession` returns nothing — the session ended, the code was reused,
 * or this browser is not the one that launched it (the host token is an httpOnly cookie, so
 * a shared /host link lands here by design).
 *
 * Same `.stage` surface as the console it replaces: a host who ended a session and hit Back
 * should not get a full-cream page in a dimmed hall, and the framework's default 404 renders
 * in its own typography outside the design system entirely.
 */
export default function HostNotFound() {
  return (
    <main className="stage flex min-h-screen flex-col items-center justify-center gap-8 p-8 text-center">
      <div>
        <h1 className="font-display text-4xl sm:text-5xl">That room is closed</h1>
        <p className="mt-3 max-w-lg text-lg text-dim">
          The session ended, or it was started from a different browser. Launch the deck again
          to get a new code.
        </p>
      </div>
      <Link href="/dashboard" className={btn('pen', 'xl')}>
        Back to your decks
      </Link>
    </main>
  )
}
