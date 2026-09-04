import 'server-only'
import { randomBytes } from 'node:crypto'
import { cache } from 'react'
import { and, asc, desc, eq, ne, sql } from 'drizzle-orm'
import { QueryBuilder } from 'drizzle-orm/pg-core'
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

/**
 * Slides per deck, as a correlated subquery.
 *
 * Built through QueryBuilder rather than written as one raw `sql` template, because in a
 * SELECT-field position Drizzle emits interpolated columns UNQUALIFIED. The hand-written
 * version came out as `(select count(*)::int from "slides" where "deck_id" = "id")` — inside
 * the subquery both names resolve against `slides`, so the predicate was `slides.deck_id =
 * slides.id`, never true, and every deck on the dashboard read "0 slides". The builder emits
 * `"slides"."deck_id" = "decks"."id"`.
 *
 * QueryBuilder, not `db`: `db` is a lazy Proxy that opens a connection on first property
 * access, and this is evaluated at module load.
 *
 * `::int` because `count(*)` is bigint, which postgres.js hands back as a string.
 */
const slideCountSql = sql<number>`(${new QueryBuilder()
  .select({ n: sql`count(*)::int` })
  .from(slides)
  .where(eq(slides.deckId, decks.id))})`

// Deliberately not `async`: a Drizzle select is a thenable, and an async wrapper would adopt
// (i.e. run) it on call. Returning the builder lets lib/decks.test.ts read `.toSQL()` without
// a database — which is the only way to assert the correlation below, since that only emits
// wrongly in a select-field position. Callers await it exactly as before. Re-adding `async`
// fails the test with a connection error rather than silently un-testing the query.
export function listDecks(ownerId: string): Promise<DeckListItem[]> {
  return db
    .select({
      id: decks.id,
      title: decks.title,
      description: decks.description,
      status: decks.status,
      updatedAt: decks.updatedAt,
      slideCount: slideCountSql,
    })
    .from(decks)
    .where(eq(decks.ownerId, ownerId))
    .orderBy(desc(decks.updatedAt))
}

// cache(): the edit page calls this AND its generateMetadata does, and both run in the same
// request. Without it the deck title in the tab costs a second round-trip.
export const getDeckWithSlides = cache(async function getDeckWithSlides(
  deckId: string,
  ownerId: string,
) {
  const [deck] = await db
    .select()
    .from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
    .limit(1)
  if (!deck) return null
  const rows = await db.select().from(slides).where(eq(slides.deckId, deckId)).orderBy(asc(slides.position))
  return { deck, slides: rows }
})

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

// --- Deck library (M9): duplicate + share ---------------------------------------------

/**
 * Copy a deck and all of its slides for the same owner.
 *
 * Deliberately does NOT call assertDeckEditable. That guard exists to stop slides shifting
 * under a running game; copying reads the original and writes somewhere else entirely, so a
 * deck that is currently live can still be duplicated — which is exactly when a teacher
 * wants to, having just watched it and wanting to fix question 4 for the next section.
 */
export async function duplicateDeck(deckId: string, ownerId: string): Promise<string> {
  const source = await getDeckWithSlides(deckId, ownerId)
  if (!source) throw new Error('deck not found')
  return copyDeckRows(source.deck, source.slides, ownerId, `${source.deck.title} (copy)`)
}

/**
 * The shared insert behind both duplicate and save-a-copy.
 *
 * Three fields are deliberately NOT carried over:
 *
 * - `sourceType` resets to 'manual'. It is not decoration: the AI rate limiter counts decks
 *   by `sourceType = 'topic'` / `'pdf'` created in the last hour (app/api/decks/generate*),
 *   so copying it would make duplicating ten decks spend the creator's whole hourly
 *   generation quota. 'manual' is also just true — a copy was copied, not generated.
 * - `sourceRef` is a Storage path or a topic string belonging to the ORIGINAL. On a
 *   cross-owner copy it would put one creator's document path on another creator's row.
 * - `shareToken` stays null. A copy inherits the content, never the audience.
 *
 * `status` DOES carry over: a copy of a valid ready deck is itself valid and ready, and
 * forcing a re-tick would be make-work.
 */
async function copyDeckRows(
  source: { title: string; description: string | null; status: string },
  sourceSlides: { position: number; type: string; prompt: string; config: SlideConfig }[],
  ownerId: string,
  title: string,
): Promise<string> {
  return db.transaction(async (tx) => {
    const [deck] = await tx
      .insert(decks)
      .values({
        ownerId,
        title,
        description: source.description,
        status: source.status,
      })
      .returning({ id: decks.id })
    if (sourceSlides.length > 0) {
      await tx.insert(slides).values(
        // Renumbered 0..n-1 rather than copying `position`: deleting a slide leaves a gap in
        // the original's column (nothing renumbers), and the copy has no reason to inherit
        // one. New row ids come from defaultRandom, so option ids inside `config` are the
        // only ids shared with the original — which is correct, they are internal to the
        // slide and never cross deck boundaries.
        sourceSlides
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((s, i) => ({
            deckId: deck.id,
            position: i,
            type: s.type,
            prompt: s.prompt,
            config: s.config,
          })),
      )
    }
    return deck.id
  })
}

/** Turn sharing on (minting a fresh token) or off. Returns the token, or null when off.
 *  Turning it on twice ROTATES the token, which is how a link is revoked and reissued. */
export async function setDeckShared(
  deckId: string,
  ownerId: string,
  shared: boolean,
): Promise<string | null> {
  // Ownership only, not editability: sharing changes nothing a live session reads.
  const [deck] = await db
    .select({ id: decks.id })
    .from(decks)
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
    .limit(1)
  if (!deck) throw new Error('deck not found')

  const token = shared ? randomBytes(16).toString('base64url') : null
  await db
    .update(decks)
    .set({ shareToken: token, updatedAt: new Date() })
    .where(and(eq(decks.id, deckId), eq(decks.ownerId, ownerId)))
  return token
}

export type SharedDeck = {
  id: string
  title: string
  description: string | null
  slides: { id: string; type: string; prompt: string; config: SlideConfig }[]
}

/**
 * A shared deck by its token, for the public /d/{token} page. No owner scoping — the token
 * IS the authorization, and it only ever matches a deck whose owner turned sharing on.
 *
 * Returns the questions AND their correct answers: the reader is another teacher deciding
 * whether the deck is any good, and a question list without its key cannot be judged. That
 * is also why sharing is opt-in and revocable — anyone holding the link sees the answers,
 * which the toggle's own copy says out loud.
 */
export async function getSharedDeck(token: string): Promise<SharedDeck | null> {
  // A blank token must never match. `shareToken` is NULL on unshared decks so SQL's
  // three-valued logic already excludes them from `= ''`, but an empty string reaching a
  // lookup at all is a bug worth failing loudly on rather than relying on that.
  if (!token) return null
  const [deck] = await db
    .select({
      id: decks.id,
      title: decks.title,
      description: decks.description,
    })
    .from(decks)
    .where(eq(decks.shareToken, token))
    .limit(1)
  if (!deck) return null
  const rows = await db
    .select({ id: slides.id, type: slides.type, prompt: slides.prompt, config: slides.config })
    .from(slides)
    .where(eq(slides.deckId, deck.id))
    .orderBy(asc(slides.position))
  return { ...deck, slides: rows }
}

/** Save a shared deck into the signed-in creator's own library. The token is the only proof
 *  of access, so it is re-resolved here rather than trusting a deck id from the client. */
export async function copySharedDeck(token: string, ownerId: string): Promise<string> {
  const [deck] = await db
    .select({
      id: decks.id,
      title: decks.title,
      description: decks.description,
      status: decks.status,
    })
    .from(decks)
    .where(eq(decks.shareToken, token))
    .limit(1)
  if (!deck) throw new Error('deck not found')
  const rows = await db
    .select({
      position: slides.position,
      type: slides.type,
      prompt: slides.prompt,
      config: slides.config,
    })
    .from(slides)
    .where(eq(slides.deckId, deck.id))
  return copyDeckRows(deck, rows, ownerId, deck.title)
}
