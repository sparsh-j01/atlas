/**
 * Test fixture: the harness provisions its own deck instead of borrowing one.
 *
 * Both scripts used to take `select ... from decks where status = 'ready' limit 1` and then
 * end every live session on whatever came back. On a machine with real content that deck is
 * somebody's — ending their room mid-class so a load test can start is not a call a test
 * script gets to make. Each run now creates a deck of its own under a synthetic creator, so
 * there is nothing of anyone else's to clean up, two concurrent runs can't collide on
 * `sessions_active_deck_idx`, and neither script needs a hand-made deck to exist first.
 */
import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import type { McqConfig } from '../lib/mcq'

// Fixed id so fixture rows are always identifiable as the harness's own. Every destructive
// statement below is scoped to it, which is what makes the sweep safe: it cannot match a
// real creator's content even if the predicate is wrong.
export const FIXTURE_OWNER = '00000000-0000-4000-8000-00000000dead'

export type Fixture = { deckId: string; ownerId: string }

/** A ready deck with `slides` MCQ slides, owned by the synthetic creator. */
export async function createFixtureDeck(
  sql: Sql,
  { slides = 2, timeLimitMs = 20_000 }: { slides?: number; timeLimitMs?: number } = {},
): Promise<Fixture> {
  await sql`
    insert into profiles (id, email, display_name)
    values (${FIXTURE_OWNER}, 'harness@test.local', 'Test harness')
    on conflict (id) do nothing`

  const [deck] = await sql`
    insert into decks (owner_id, title, status)
    values (${FIXTURE_OWNER}, ${`Harness fixture ${new Date().toISOString()}`}, 'ready')
    returning id`

  for (let i = 0; i < slides; i++) {
    // Option ids are per-slide uuids exactly as the editor writes them, so an answer aimed
    // at the wrong slide fails the same id check it fails in a real game.
    const config: McqConfig = {
      options: ['A', 'B', 'C', 'D'].map((t, j) => ({
        id: randomUUID(),
        text: `Option ${t}`,
        is_correct: j === 0,
      })),
      timeLimitMs,
      points: 1_000,
      explanation: `Option A is correct on fixture question ${i + 1}.`,
    }
    await sql`
      insert into slides (deck_id, position, type, prompt, config)
      values (${deck.id}, ${i}, 'quiz_mcq', ${`Fixture question ${i + 1}`}, ${sql.json(config)})`
  }

  return { deckId: deck.id, ownerId: FIXTURE_OWNER }
}

/** Remove a run's own deck. Owner-scoped so a wrong id can only ever delete a fixture. */
export async function dropFixtureDeck(sql: Sql, deckId: string): Promise<void> {
  await sql`delete from decks where id = ${deckId} and owner_id = ${FIXTURE_OWNER}`
}

/**
 * Clear fixtures left behind by an interrupted run. Scoped to FIXTURE_OWNER, so it can only
 * touch the harness's own rows — never a creator's deck, which is the whole point of the
 * rewrite. A live room goes out through the **end endpoint** rather than a status UPDATE, so
 * anything still connected gets `session:ended` like any other ending; a room whose end call
 * fails is left alone rather than orphaned by deleting its deck out from under it.
 *
 * Only decks older than an hour: a concurrent run's fresh fixture must survive this.
 */
export async function sweepStaleFixtures(
  sql: Sql,
  endRoom: (code: string, hostToken: string) => Promise<boolean>,
): Promise<number> {
  const stale = await sql<{ deckId: string; code: string | null; hostToken: string | null }[]>`
    select d.id as "deckId", s.code, s.host_token as "hostToken"
    from decks d
    left join sessions s on s.deck_id = d.id and s.status <> 'ended'
    where d.owner_id = ${FIXTURE_OWNER} and d.created_at < now() - interval '1 hour'`

  let cleared = 0
  for (const row of stale) {
    if (row.code && row.hostToken && !(await endRoom(row.code, row.hostToken))) continue
    await dropFixtureDeck(sql, row.deckId)
    cleared++
  }
  return cleared
}
