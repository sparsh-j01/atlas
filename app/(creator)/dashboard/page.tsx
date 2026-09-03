import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { listDecks } from '@/lib/decks'
import { createDeckAction, deleteDeckAction, launchDeckAction } from '@/lib/actions'
import { DeleteButton } from '@/components/DeleteButton'
import { btn, statusDotCls, tileCls } from '@/components/ui'

export const metadata = { title: 'Your decks' }

export default async function DashboardPage() {
  const user = await requireUser()
  const decks = await listDecks(user.id)

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <h1 className="font-display text-[44px] leading-none">Your decks</h1>
          <p className="mt-3 text-dim">
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
        <div className="mt-12 flex flex-col items-center rounded-plate border border-rule bg-raised px-8 py-20 text-center shadow-lift">
          <h2 className="font-display text-[30px]">Build your first deck</h2>
          <p className="mx-auto mt-4 max-w-md leading-relaxed text-dim">
            Upload a lecture PDF and Atlas writes questions from the passages inside it, or
            describe a topic and it writes from scratch. You review everything before the
            class sees it.
          </p>
          {/* This screen's one rotated element. */}
          <p className="font-pen mt-8 -rotate-2 text-[22px] text-pen-ink">
            Takes about a minute.
          </p>
          <Link href="/decks/new" className={`${btn('primary', 'lg')} mt-5`}>
            Build a deck
          </Link>
        </div>
      ) : (
        <ul className="mt-12 flex flex-col gap-3">
          {decks.map((d) => (
            // Stacks below sm rather than relying on flex-wrap. Wrapping never triggered:
            // the title link is `flex-1 min-w-0`, so on a 390px phone it absorbed all the
            // shortfall instead of pushing the buttons to a second line — a ready row (which
            // carries the extra Present button) squeezed the deck name down to 5px, one
            // letter wide, while the draft row above it looked fine.
            <li
              key={d.id}
              className={`${tileCls} flex flex-col gap-4 px-5 py-4 transition-colors hover:border-rule-strong sm:flex-row sm:items-center`}
            >
              <Link href={`/decks/${d.id}/edit`} className="min-w-0 sm:flex-1">
                <div className="font-display truncate text-[20px]">{d.title}</div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-dim">
                  <span className="tabular whitespace-nowrap">
                    {d.slideCount} {d.slideCount === 1 ? 'slide' : 'slides'}
                  </span>
                  <StatusDot status={d.status} />
                </div>
              </Link>
              {/* One group, so the actions wrap together instead of one at a time. */}
              <div className="flex flex-wrap items-center gap-3">
                {d.status === 'ready' && (
                  <form action={launchDeckAction.bind(null, d.id)}>
                    <button className={btn('primary', 'md')}>Present {srDeck(d.title)}</button>
                  </form>
                )}
                <Link href={`/decks/${d.id}/edit`} className={btn('secondary', 'md')}>
                  Edit {srDeck(d.title)}
                </Link>
                <DeleteButton
                  action={deleteDeckAction.bind(null, d.id)}
                  confirmText={`Delete "${d.title}" and all its slides?`}
                  name={d.title}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Names which deck a repeated row action belongs to, without putting the title on screen
 *  twice. Every row offers "Present" / "Edit" / "Delete"; unscoped they are one verb
 *  repeated down the list with nothing to tell them apart. */
function srDeck(title: string) {
  return <span className="sr-only">{title}</span>
}

/** Ready is the only state that unlocks Present, so it is the only one that gets the pen.
 *  The dot itself comes from `statusDotCls` — the editor draws the same one. */
function StatusDot({ status }: { status: string }) {
  const ready = status === 'ready'
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className={statusDotCls(ready)} />
      <span className={ready ? 'text-pen-ink' : undefined}>{ready ? 'Ready' : 'Draft'}</span>
    </span>
  )
}
