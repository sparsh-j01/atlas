import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { listDecks } from '@/lib/decks'
import { createDeckAction, deleteDeckAction, launchDeckAction } from '@/lib/actions'
import { DeleteButton } from '@/components/DeleteButton'
import { btn, panelCls } from '@/components/ui'

export default async function DashboardPage() {
  const user = await requireUser()
  const decks = await listDecks(user.id)

  return (
    <div className="mx-auto max-w-6xl px-6 py-12">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-4xl">Your decks</h1>
          <p className="mt-2 text-dim">
            {decks.length === 0
              ? 'Nothing here yet.'
              : `${decks.length} ${decks.length === 1 ? 'deck' : 'decks'}. A deck has to be marked ready before it can host.`}
          </p>
        </div>
        <div className="flex gap-3">
          <form action={createDeckAction}>
            <button className={btn('secondary', 'lg')}>Start blank</button>
          </form>
          <Link href="/decks/new" className={btn('primary', 'lg')}>
            Build a deck
          </Link>
        </div>
      </div>

      {decks.length === 0 ? (
        <div className={`${panelCls} mt-10 px-8 py-16 text-center`}>
          <h2 className="font-display text-2xl">Build your first deck</h2>
          <p className="mx-auto mt-3 max-w-md leading-relaxed text-dim">
            Upload a lecture PDF and Atlas writes questions from the passages inside it, or
            describe a topic and it writes from scratch. You review everything before the
            class sees it.
          </p>
          <Link href="/decks/new" className={`${btn('primary', 'lg')} mt-8`}>
            Build a deck
          </Link>
        </div>
      ) : (
        <ul className="mt-10 flex flex-col gap-3">
          {decks.map((d) => (
            <li
              key={d.id}
              className={`${panelCls} flex flex-wrap items-center gap-4 px-5 py-4 transition-colors hover:border-rule-strong`}
            >
              <Link href={`/decks/${d.id}/edit`} className="min-w-0 flex-1">
                <div className="truncate text-lg font-semibold">{d.title}</div>
                <div className="mt-1 flex items-center gap-3 text-sm text-dim">
                  <span className="font-data">
                    {d.slideCount} {d.slideCount === 1 ? 'slide' : 'slides'}
                  </span>
                  <StatusDot status={d.status} />
                </div>
              </Link>
              {d.status === 'ready' && (
                <form action={launchDeckAction.bind(null, d.id)}>
                  <button className={btn('primary', 'md')}>Present</button>
                </form>
              )}
              <Link href={`/decks/${d.id}/edit`} className={btn('secondary', 'md')}>
                Edit
              </Link>
              <DeleteButton
                action={deleteDeckAction.bind(null, d.id)}
                confirmText={`Delete "${d.title}" and all its slides?`}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Ready is the only state that unlocks Present, so it is the only one that gets colour. */
function StatusDot({ status }: { status: string }) {
  const ready = status === 'ready'
  return (
    <span className="flex items-center gap-1.5">
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-correct' : 'bg-faint'}`}
      />
      <span className={ready ? 'text-correct' : undefined}>{ready ? 'Ready' : 'Draft'}</span>
    </span>
  )
}
