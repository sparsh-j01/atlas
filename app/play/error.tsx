'use client'

import { btn } from '@/components/ui'

/**
 * The participant's error boundary.
 *
 * Without it a client error on a phone fell through to `app/error.tsx`, which is a paper
 * surface: a full-cream screen at full brightness, in a hand, in a dimmed lecture hall. It
 * also offered "Your decks" pointing at `/dashboard` — a creator route the student has no
 * account for and no way past. Same reasoning as the host console's own boundary
 * (`app/host/[code]/error.tsx`), which exists because a transient failure once put Next's
 * default error page on a projector.
 *
 * The recovery here is deliberately not a link. A participant's seat lives in localStorage
 * and is redeemed by the play page on mount, so retrying puts them back in the same room on
 * the slide the host is currently showing. Sending them anywhere else would cost them the
 * seat and make them rejoin under a new nickname, losing their score.
 */
export default function PlayError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <main className="stage flex min-h-svh flex-col items-center justify-center gap-6 p-8 text-center">
      <div>
        <h1 className="font-display text-3xl">Lost the room</h1>
        <p className="mt-3 text-dim">
          Your place is saved. Rejoining puts you back on the question the class is on.
        </p>
      </div>
      {/* touch-action, as on the answer tiles: this is the one control on the screen and a
          300ms tap delay on it reads as the retry having failed. */}
      <button
        onClick={() => retry()}
        style={{ touchAction: 'manipulation' }}
        className={`${btn('pen', 'xl')} active:scale-[0.97]`}
      >
        Rejoin
      </button>
      {error.digest && <p className="text-sm text-dim">Reference {error.digest}</p>}
    </main>
  )
}
