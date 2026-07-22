import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getDeckWithSlides } from '@/lib/decks'
import { DeckEditor } from '@/components/DeckEditor'

export default async function EditDeckPage({ params }: { params: Promise<{ deckId: string }> }) {
  const { deckId } = await params
  const user = await requireUser()
  const data = await getDeckWithSlides(deckId, user.id)
  if (!data) notFound() // not owned or doesn't exist — same 404 either way (no ownership leak)

  return <DeckEditor deck={data.deck} slides={data.slides} />
}
