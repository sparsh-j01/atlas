import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { listDecks } from '@/lib/decks'
import { FAILED_STATES, listDocuments, type Document as Upload, type IngestionState } from '@/lib/documents'
import {
  createDeckAction,
  deleteDeckAction,
  deleteDocumentAction,
  duplicateDeckAction,
  launchDeckAction,
} from '@/lib/actions'
import { DeleteButton } from '@/components/DeleteButton'
import { LocalTime } from '@/components/LocalTime'
import { btn, statusDotCls, tileCls } from '@/components/ui'

export const metadata = { title: 'Your decks' }

export default async function DashboardPage() {
  const user = await requireUser()
  const [decks, uploads] = await Promise.all([listDecks(user.id), listDocuments(user.id)])

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
            // carries the extra Start live class button) squeezed the deck name down to 5px, one
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
                    <button className={btn('primary', 'md')}>Start live class {srDeck(d.title)}</button>
                  </form>
                )}
                <Link href={`/decks/${d.id}/edit`} className={btn('secondary', 'md')}>
                  Edit {srDeck(d.title)}
                </Link>
                {/* A plain form post, not a confirm: duplicating is additive and the copy
                    opens in the editor, so the undo is deleting the thing you are looking
                    at. Delete keeps its confirmation because that one is not reversible. */}
                <form action={duplicateDeckAction.bind(null, d.id)}>
                  <button className={btn('ghost', 'md')}>Duplicate {srDeck(d.title)}</button>
                </form>
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

      {/* The only place a teacher can see what they have uploaded, and so the only place they
          can delete it — which the privacy policy promises they can. */}
      {uploads.length > 0 && (
        <section className="mt-16" aria-labelledby="uploads-heading">
          <h2 id="uploads-heading" className="font-display text-[30px] leading-none">
            Uploaded files
          </h2>
          <p className="mt-3 text-dim">
            Deleting a file removes it and the text we read from it. Decks built from it stay.
          </p>
          <ul className="mt-6 flex flex-col gap-3">
            {uploads.map((doc) => (
              <li
                key={doc.id}
                className={`${tileCls} flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center`}
              >
                <div className="min-w-0 sm:flex-1">
                  <div className="truncate font-semibold">{doc.filename}</div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-sm text-dim">
                    <span className="tabular whitespace-nowrap">
                      {doc.pageCount} {doc.sourceType === 'pptx' ? 'slides' : 'pages'}
                    </span>
                    <span>{uploadState(doc)}</span>
                    <LocalTime iso={doc.createdAt.toISOString()} dateOnly />
                  </div>
                </div>
                <DeleteButton
                  action={deleteDocumentAction.bind(null, doc.id)}
                  confirmText="Delete this file? Its decks stay."
                  name={doc.filename}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/** Ready, failed, or neither. "Not finished" rather than "Processing": ingestion only runs
 *  while the upload page is open, so a document in a middle stage is usually just abandoned. */
function uploadState(doc: Upload) {
  if (doc.status === 'ready') return 'Ready'
  if (FAILED_STATES.includes(doc.status as IngestionState)) return 'Failed'
  return 'Not finished'
}

/** Names which deck a repeated row action belongs to, without putting the title on screen
 *  twice. Every row offers "Start live class" / "Edit" / "Delete"; unscoped they are one verb
 *  repeated down the list with nothing to tell them apart. */
function srDeck(title: string) {
  return <span className="sr-only">{title}</span>
}

/** Ready is the only state that unlocks Start live class, so it is the only one that gets the pen.
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
