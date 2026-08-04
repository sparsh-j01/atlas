'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { createClient } from '@/lib/supabase/server'
import * as data from '@/lib/decks'
import { createSessionFromDeck } from '@/lib/sessions'
import {
  blankSlide,
  isSlideType,
  toEditable,
  toStoredSlide,
  validateSlide,
  type EditableSlide,
  type SlideType,
} from '@/lib/slides'

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

export async function addSlideAction(deckId: string, type: SlideType) {
  const user = await requireUser()
  // `type` crosses the client boundary, and it's written straight into a column the live
  // session engine dispatches on — check it against the known set rather than trusting it.
  if (!isSlideType(type)) throw new Error('unknown slide type')
  const stored = toStoredSlide(blankSlide(type)) // blank template — filled in, then saved (validated)
  await data.addSlide(deckId, user.id, { type, prompt: stored.prompt, config: stored.config })
  revalidatePath(editPath(deckId))
  revalidatePath('/dashboard') // slide count is rendered on the dashboard
}

export async function saveSlideAction(
  deckId: string,
  slideId: string,
  draft: EditableSlide,
): Promise<{ errors: string[] }> {
  const user = await requireUser()
  if (!isSlideType(draft.type)) return { errors: ['Unknown slide type.'] }
  const errors = validateSlide(draft) // server re-validates; never trust the client's gate
  if (errors.length) return { errors }
  // `type` is written alongside `config`, not left as whatever the row already had. Nothing
  // in the database ties the two together (type is text, config is jsonb), so writing them
  // in one statement is what keeps them from disagreeing — a draft can't leave a poll config
  // filed under a quiz type for the session engine to trip over later.
  await data.updateSlide(deckId, slideId, user.id, { type: draft.type, ...toStoredSlide(draft) })
  revalidatePath(editPath(deckId))
  return { errors: [] }
}

export async function deleteSlideAction(deckId: string, slideId: string) {
  const user = await requireUser()
  await data.deleteSlide(deckId, slideId, user.id)
  revalidatePath(editPath(deckId))
  revalidatePath('/dashboard') // slide count is rendered on the dashboard
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
    // Numbered by list position, not by `position` — deleting a slide leaves a gap in the
    // column (lib/decks.ts doesn't renumber), so `position + 1` could name a slide the
    // editor labels differently. `dw.slides` is already ordered by position.
    for (const [i, s] of dw.slides.entries()) {
      const draft = toEditable(s)
      // type/config disagree — unreachable through the editor, but this is the gate that
      // decides what may reach a live room, so it fails closed rather than assuming.
      if (!draft) return { error: `Slide ${i + 1} has an unrecognised type.` }
      const errs = validateSlide(draft)
      if (errs.length) return { error: `Slide ${i + 1} is incomplete: ${errs[0]}` }
    }
  }
  await data.updateDeck(deckId, user.id, { status })
  revalidatePath(editPath(deckId))
  revalidatePath('/dashboard')
  return {}
}

/** Launch one of the creator's ready decks into a live lobby. Creates the session, stashes
 *  the host token in an httpOnly cookie (never the URL — it's what authorizes advance/reveal),
 *  and sends the host to the lobby. Present is only offered on ready decks, so a thrown
 *  eligibility error here is a rare race — let it hit the error boundary. */
export async function launchDeckAction(deckId: string): Promise<void> {
  const user = await requireUser()
  const { code, hostToken } = await createSessionFromDeck(deckId, user.id)
  ;(await cookies()).set(`htk_${code}`, hostToken, {
    httpOnly: true,
    // This cookie IS the credential for advance/reveal/end, so it must never ride a
    // plaintext request — an http:// hit on a custom domain would leak it before the
    // redirect to HTTPS. Conditional, not a literal `true`, so http://localhost still works.
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/', // must cover /api/sessions/*, not just /host — that's what the token authorizes
    maxAge: 60 * 60 * 6, // 6h — long enough to run a session; this cookie is the host's key to it
  })
  redirect(`/host/${code}`)
}

export async function signOutAction() {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect('/login')
}
