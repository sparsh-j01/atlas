'use client'

import { useParams } from 'next/navigation'
import { btn, capCls } from '@/components/ui'

/**
 * The projector's error state.
 *
 * This is not a hypothetical: a transient DNS failure to the Supabase pooler mid-session put
 * Next's default "A server error occurred — ERROR 852688886" on a screen in front of a class.
 * Whatever breaks, this screen is on a wall, so it keeps the `.stage` surface (a cream
 * flashbang in a dimmed hall is its own failure), keeps the room code visible so nobody's
 * phone drops out of the room, and says something a room of students can read.
 *
 * `retry`, not `reset` (Next 16): the common cause here is a transient connection blip, and
 * retry re-fetches the segment rather than just re-rendering the same failed state.
 */
export default function HostError({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  // The code is in the URL, which survives the error the page did not.
  const code = useParams<{ code: string }>().code

  return (
    <main className="stage flex min-h-screen flex-col items-center justify-center gap-8 p-8 text-center">
      <div>
        <div className={capCls}>Room</div>
        <div className="tabular mt-1 text-5xl leading-none tracking-[0.14em] text-pen sm:text-6xl">
          {code}
        </div>
      </div>

      <div>
        <h1 className="font-display text-4xl sm:text-5xl">One moment</h1>
        <p className="mt-3 max-w-lg text-lg text-dim">
          The room is still open and nobody has been kicked out. This screen lost its
          connection — try again, and everyone can stay where they are.
        </p>
      </div>

      <button onClick={() => retry()} className={btn('pen', 'xl')}>
        Try again
      </button>

      {/* The digest is what matches this to a server log. Small, and last — it is on a wall.
          --dim, not --faint: --faint is a non-text token (docs/design.md §3). */}
      {error.digest && <p className="text-sm text-dim">Reference {error.digest}</p>}
    </main>
  )
}
