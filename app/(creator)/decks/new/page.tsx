import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { DeckBuilder } from '@/components/DeckBuilder'

// Both generation front doors. Either route persists a DRAFT and sends the creator into the
// editor. Nothing goes live without review, and marking a deck ready re-runs the validators.

export default async function NewDeckPage() {
  await requireUser()

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/dashboard" className="text-sm text-dim transition-colors hover:text-ink">
        Back to your decks
      </Link>
      <h1 className="font-display mt-6 text-4xl">Build a deck</h1>
      <p className="mt-3 max-w-xl leading-relaxed text-dim">
        You get a draft to review and edit. It cannot host a session until you mark it ready.
      </p>
      <DeckBuilder />
    </div>
  )
}
