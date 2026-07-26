import 'server-only'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { decks, sessions, slides } from '@/lib/db/schema'
import type { SlideConfig } from '@/lib/slides'

// Every function is owner-scoped in its WHERE — this is the real access boundary (Drizzle
// connects as postgres and bypasses RLS; the RLS policies are defense-in-depth). Slide ops
// take deckId too so ownership + the parent-deck `updatedAt` bump reduce to one owned deck.

export type DeckListItem = {
  id: string
  title: string
  description: string | null
  status: string
  updatedAt: Date
  slideCount: number
}

export async function listDecks(ownerId: string): Promise<DeckListItem[]> {
  return db
    .select({
      id: decks.id,
      title: decks.title,
      description: decks.description,
      status: decks.status,
      updatedAt: decks.updatedAt,
      slideCount: sql<number>`(select count(*)::int from ${slides} where ${slides.deckId} = ${decks.id})`,
    })
    .from(decks)
    .where(eq(decks.ownerId, ownerId))
    .orderBy(desc(decks.updatedAt))
}

export async function getDeckWithSlides(deckId: string, ownerId: string) {
  const [deck] = await db
    .select()
    .from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
    .limit(1)
  if (!deck) return null
  const rows = await db.select().from(slides).where(eq(slides.deckId, deckId)).orderBy(asc(slides.position))
  return { deck, slides: rows }
}

// Guard for every deck mutation: the deck must be the caller's AND not currently live. A
// non-ended session freezes the deck so its slides can't shift under a running game
// (docs/schema.md) — one check all mutators route through, rather than per-action guards.
async function assertDeckEditable(deckId: string, ownerId: string): Promise<void> {
  const [deck] = await db
    .select({ id: decks.id })
    .from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
    .limit(1)
  if (!deck) throw new Error('deck not found')
  const [live] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.deckId, deckId), ne(sessions.status, 'ended')))
    .limit(1)
  if (live) throw new Error('This deck is live — end the session before editing it.')
}

async function touchDeck(deckId: string, ownerId: string): Promise<void> {
  await db
    .update(decks)
    .set({ updatedAt: new Date() })
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
}

export async function createDeck(ownerId: string) {
  const [deck] = await db.insert(decks).values({ ownerId, title: 'Untitled deck' }).returning()
  return deck
}

export async function deleteDeck(deckId: string, ownerId: string): Promise<void> {
  await assertDeckEditable(deckId, ownerId)
  await db.delete(decks).where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
}

export async function updateDeck(
  deckId: string,
  ownerId: string,
  patch: { title?: string; description?: string | null; status?: string },
): Promise<void> {
  await assertDeckEditable(deckId, ownerId)
  await db
    .update(decks)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
}

export async function addSlide(
  deckId: string,
  ownerId: string,
  slide: { type: string; prompt: string; config: SlideConfig },
) {
  await assertDeckEditable(deckId, ownerId)
  // Lock the deck row so concurrent addSlide calls for the same deck serialize — otherwise
  // both read the same max(position) and the second insert trips the unique(deck_id, position).
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select 1 from ${decks} where ${decks.id} = ${deckId} for update`)
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${slides.position}) + 1, 0)` })
      .from(slides)
      .where(eq(slides.deckId, deckId))
    const [inserted] = await tx
      .insert(slides)
      .values({ deckId, position: next, type: slide.type, prompt: slide.prompt, config: slide.config })
      .returning()
    return inserted
  })
  await touchDeck(deckId, ownerId)
  return row
}

export async function updateSlide(
  deckId: string,
  slideId: string,
  ownerId: string,
  // `type` moves with `config`: nothing in the schema ties them together, so they're only
  // ever consistent because every write sets both (see saveSlideAction).
  patch: { type: string; prompt: string; config: SlideConfig },
): Promise<void> {
  await assertDeckEditable(deckId, ownerId)
  await db
    .update(slides)
    .set({ type: patch.type, prompt: patch.prompt, config: patch.config })
    .where(and(eq(slides.id, slideId), eq(slides.deckId, deckId)))
  await touchDeck(deckId, ownerId)
}

export async function deleteSlide(deckId: string, slideId: string, ownerId: string): Promise<void> {
  await assertDeckEditable(deckId, ownerId)
  await db.delete(slides).where(and(eq(slides.id, slideId), eq(slides.deckId, deckId)))
  await touchDeck(deckId, ownerId)
}

/** Rewrite every slide's position to its index in `orderedIds`. The deferred
 *  unique(deck_id, position) constraint lets all rows move in one transaction. */
export async function reorderSlides(deckId: string, ownerId: string, orderedIds: string[]): Promise<void> {
  await assertDeckEditable(deckId, ownerId)
  await db.transaction(async (tx) => {
    const current = await tx.select({ id: slides.id }).from(slides).where(eq(slides.deckId, deckId))
    const currentSet = new Set(current.map((s) => s.id))
    // Must be an exact permutation of this deck's slides — reject missing/extra/foreign/duplicate
    // ids. Checking orderedSet.size guards against duplicates masking an omitted id (e.g.
    // [a,a,b] vs {a,b,c} would otherwise pass the length+membership test and corrupt order).
    const orderedSet = new Set(orderedIds)
    if (
      orderedSet.size !== orderedIds.length ||
      orderedSet.size !== currentSet.size ||
      !orderedIds.every((id) => currentSet.has(id))
    ) {
      throw new Error('reorder set mismatch')
    }
    for (let i = 0; i < orderedIds.length; i++) {
      await tx.update(slides).set({ position: i }).where(and(eq(slides.id, orderedIds[i]), eq(slides.deckId, deckId)))
    }
  })
  await touchDeck(deckId, ownerId)
}
