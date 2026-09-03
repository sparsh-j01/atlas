import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// A real Drizzle instance over a postgres.js client that is never queried — postgres.js
// connects lazily, and `.toSQL()` does not execute. This is what lets the assertion run
// against the ACTUAL query listDecks builds rather than a copy of it reconstructed here.
vi.mock('@/lib/db', async () => {
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const postgres = (await import('postgres')).default
  return { db: drizzle(postgres('postgres://u:p@127.0.0.1:5432/none', { prepare: false })) }
})

// The dashboard's slide count was wrong for the life of the feature: the correlated subquery
// was a raw sql`` template, and Drizzle emits interpolated columns UNQUALIFIED inside a
// SELECT field. `where ${slides.deckId} = ${decks.id}` came out as `where "deck_id" = "id"`,
// both binding to `slides` in the subquery's own scope — never true, so every deck read 0.
//
// The assertion has to run on the whole query, not on the subquery alone: rendered
// standalone the buggy template emits fully qualified names and looks correct. The select
// field is the only position where the difference exists, which is exactly why it survived.
describe('listDecks', () => {
  it('correlates the slide count to the outer deck, not to slides', async () => {
    const { listDecks } = await import('@/lib/decks')
    // listDecks is not `async`, so this is the un-executed builder, not a running query.
    const query = listDecks('owner-1') as unknown as { toSQL(): { sql: string } }
    const { sql } = query.toSQL()

    expect(sql).toContain('"slides"."deck_id" = "decks"."id"')
    // The shipped bug, named directly.
    expect(sql).not.toMatch(/where "deck_id" = "id"/)
    // count(*) is bigint; postgres.js returns those as strings, so slideCount would be
    // "4" and `slideCount === 1` would never match the singular label.
    expect(sql).toContain('count(*)::int')
  })
})
