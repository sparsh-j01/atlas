import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { listEndedSessions } from '@/lib/sessions'
import { LocalTime } from '@/components/LocalTime'
import { btn, tileCls } from '@/components/ui'

export const metadata = { title: 'Results' }

export default async function ResultsPage() {
  const user = await requireUser()
  const runs = await listEndedSessions(user.id)

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-[44px] leading-none">Results</h1>
          <p className="mt-3 text-dim">
            {runs.length === 0
              ? 'Nothing here yet.'
              : `${runs.length} finished ${runs.length === 1 ? 'session' : 'sessions'}.`}
          </p>
        </div>
        <Link href="/dashboard" className={btn('secondary', 'lg')}>
          Your decks
        </Link>
      </div>

      {runs.length === 0 ? (
        <div className="mt-12 flex flex-col items-center rounded-plate border border-rule bg-raised px-8 py-20 text-center shadow-lift">
          <h2 className="font-display text-[30px]">No sessions yet</h2>
          <p className="mx-auto mt-4 max-w-md leading-relaxed text-dim">
            Present a deck to a class and its results land here when you end the session:
            how the room answered each question, and how every player did.
          </p>
          {/* This screen's one rotated element, matching the dashboard's empty state. */}
          <p className="font-pen mt-8 -rotate-2 text-[22px] text-pen-ink">Nothing is deleted.</p>
          <Link href="/dashboard" className={`${btn('primary', 'lg')} mt-5`}>
            Your decks
          </Link>
        </div>
      ) : (
        <ul className="mt-12 flex flex-col gap-3">
          {runs.map((r) => (
            // Same row shape as the dashboard's deck list, on purpose — a creator moving
            // between the two screens reads one pattern, not two.
            <li
              key={r.id}
              className={`${tileCls} flex flex-col gap-4 px-5 py-4 transition-colors hover:border-rule-strong sm:flex-row sm:items-center`}
            >
              <Link href={`/results/${r.id}`} className="min-w-0 sm:flex-1">
                <div className="font-display truncate text-[20px]">
                  {r.deckTitle ?? 'Deleted deck'}
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-dim">
                  <LocalTime iso={(r.endedAt ?? r.createdAt).toISOString()} />
                  <span className="tabular whitespace-nowrap">
                    {r.players} {r.players === 1 ? 'player' : 'players'}
                  </span>
                </div>
              </Link>
              <div className="flex flex-wrap items-center gap-3">
                <Link href={`/results/${r.id}`} className={btn('secondary', 'md')}>
                  Open
                  {/* Every row offers the same verb; the deck name tells the instances
                      apart for a screen reader without printing it twice. */}
                  <span className="sr-only"> {r.deckTitle ?? 'deleted deck'} results</span>
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
