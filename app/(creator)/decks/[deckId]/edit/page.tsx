import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getDeckWithSlides } from '@/lib/decks'
import { DeckEditor } from '@/components/DeckEditor'

// The deck's own name, so two editor tabs are distinguishable. Same cached fetch the page
// uses, so this costs no extra query. Falls back rather than 404ing here — the page below
// is what decides that.
export async function generateMetadata({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = await params
  const user = await requireUser()
  const data = await getDeckWithSlides(deckId, user.id)
  return { title: data?.deck.title || 'Untitled deck' }
}

export default async function EditDeckPage({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = await params
  const user = await requireUser()
  const data = await getDeckWithSlides(deckId, user.id)
  if (!data) notFound() // not owned or doesn't exist — same 404 either way (no ownership leak)

  return <DeckEditor deck={data.deck} slides={data.slides} />
}
