import Link from 'next/link'
import { btn } from '@/components/ui'

/**
 * The creator area's own 404, reached when `notFound()` fires from the deck editor — the
 * deck was deleted, or it belongs to someone else (same 404 either way, so ownership never
 * leaks).
 *
 * Without this file the root `app/not-found.tsx` answered instead, and because it sits above
 * `(creator)/layout.tsx` in the tree it took the whole creator chrome with it: no header, no
 * wordmark, no sign-out, and two actions ("Join a room", "Atlas home") aimed at a student
 * rather than at the signed-in teacher who followed a stale editor link. Living here keeps
 * the layout and points the one link that matters back at their decks.
 */
export default function CreatorNotFound() {
  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-6 px-6 py-24 text-center">
      <div>
        <h1 className="font-display text-[44px] leading-none">That deck is gone</h1>
        <p className="mt-3 text-dim">
          It was deleted, or the link belongs to a different account. Everything else is
          still where you left it.
        </p>
      </div>
      <Link href="/dashboard" className={btn('primary', 'lg')}>
        Back to your decks
      </Link>
    </div>
  )
}
