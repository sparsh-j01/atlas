'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import * as data from '@/lib/decks'
import { blankMcq, toStored, validateMcq, type EditableMcq } from '@/lib/mcq'

const editPath = (deckId: string) => `/decks/${deckId}/edit`

export async function createDeckAction() {
  const user = await requireUser()
  const deck = await data.createDeck(user.id)
  redirect(editPath(deck.id))
}

export async function deleteDeckAction(deckId: string) {
  const user = await requireUser()
  await data.deleteDeck(deckId, user.id)
  revalidatePath('/dashboard')
}

export async function updateDeckAction(
  deckId: string,
  patch: { title?: string; description?: string | null },
) {
  const user = await requireUser()
  // Title can't be blank; fall back rather than persist an empty title.
  const clean = { ...patch }
  if (clean.title !== undefined && !clean.title.trim()) clean.title = 'Untitled deck'
  await data.updateDeck(deckId, user.id, clean)
  revalidatePath(editPath(deckId))
  revalidatePath('/dashboard')
}

export async function addSlideAction(deckId: string) {
  const user = await requireUser()
  const stored = toStored(blankMcq()) // blank MCQ template — filled in, then saved (validated)
  await data.addSlide(deckId, user.id, { type: 'quiz_mcq', prompt: stored.prompt, config: stored.config })
  revalidatePath(editPath(deckId))
}

export async function saveSlideAction(
  deckId: string,
  slideId: string,
  draft: EditableMcq,
): Promise<{ errors: string[] }> {
  const user = await requireUser()
  const errors = validateMcq(draft) // server re-validates; never trust the client's gate
  if (errors.length) return { errors }
  await data.updateSlide(deckId, slideId, user.id, toStored(draft))
  revalidatePath(editPath(deckId))
  return { errors: [] }
}

export async function deleteSlideAction(deckId: string, slideId: string) {
  const user = await requireUser()
  await data.deleteSlide(deckId, slideId, user.id)
  revalidatePath(editPath(deckId))
}

export async function reorderSlidesAction(deckId: string, orderedIds: string[]) {
  const user = await requireUser()
  await data.reorderSlides(deckId, user.id, orderedIds)
  revalidatePath(editPath(deckId))
}

/** Flip draft ⇄ ready. Going `ready` gates on every slide being valid (the deck-level
 *  validation the plan calls for), so a broken slide can't reach a live room in M3. */
export async function setDeckStatusAction(
  deckId: string,
  status: 'draft' | 'ready',
): Promise<{ error?: string }> {
  const user = await requireUser()
  if (status === 'ready') {
    const dw = await data.getDeckWithSlides(deckId, user.id)
    if (!dw) return { error: 'Deck not found.' }
    if (dw.slides.length === 0) return { error: 'Add at least one slide first.' }
    for (const s of dw.slides) {
      const errs = validateMcq({
        prompt: s.prompt,
        options: s.config.options,
        timeLimitMs: s.config.timeLimitMs,
        points: s.config.points,
      })
      if (errs.length) return { error: `Slide ${s.position + 1} is incomplete: ${errs[0]}` }
    }
  }
  await data.updateDeck(deckId, user.id, { status })
  revalidatePath(editPath(deckId))
  revalidatePath('/dashboard')
  return {}
}

export async function signOutAction() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
