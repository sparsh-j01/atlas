import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { DeckBuilder } from '@/components/DeckBuilder'

// Both generation front doors. Either route persists a DRAFT and sends the creator into the
// editor. Nothing goes live without review, and marking a deck ready re-runs the validators.

export const metadata = { title: 'Build a deck' }

export default async function NewDeckPage() {
  await requireUser()

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-8 sm:py-10">
      <Link href="/dashboard" className="text-sm font-semibold text-dim transition-colors hover:text-ink">
        Back to your decks
      </Link>
      <h1 className="mt-6 text-3xl font-semibold tracking-tight">Build a deck</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-dim">
        Start with your lecture material or a topic, then review the questions.
      </p>
      <DeckBuilder />
    </div>
  )
}
