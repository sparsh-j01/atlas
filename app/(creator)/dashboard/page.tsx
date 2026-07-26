import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { listDecks } from '@/lib/decks'
import { createDeckAction, deleteDeckAction, launchDeckAction } from '@/lib/actions'
import { DeleteButton } from '@/components/DeleteButton'

export default async function DashboardPage() {
  const user = await requireUser()
  const decks = await listDecks(user.id)

  return (
    <div className="mx-auto max-w-3xl p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Your decks</h1>
        <form action={createDeckAction}>
          <button className="rounded-lg bg-indigo-600 px-4 py-2 font-medium text-white">New deck</button>
        </form>
      </div>

      {decks.length === 0 ? (
        <p className="mt-16 text-center text-neutral-500">No decks yet — create your first one.</p>
      ) : (
        <ul className="mt-6 flex flex-col gap-3">
          {decks.map((d) => (
            <li
              key={d.id}
              className="flex items-center gap-4 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800"
            >
              <Link href={`/decks/${d.id}/edit`} className="min-w-0 flex-1">
                <div className="truncate font-medium">{d.title}</div>
                <div className="text-sm text-neutral-500">
                  {d.slideCount} {d.slideCount === 1 ? 'slide' : 'slides'} · {d.status}
                </div>
              </Link>
              {d.status === 'ready' && (
                <form action={launchDeckAction.bind(null, d.id)}>
                  <button className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white">
                    Present
                  </button>
                </form>
              )}
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
