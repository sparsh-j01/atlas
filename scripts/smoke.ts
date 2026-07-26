/**
 * Live-session acceptance walk — the M3 "done when" proof, and the check that fails if a
 * later change loosens one of the guards. Unit tests cover the pure logic; this one drives
 * the real HTTP routes against a real database, because that's the only place the anti-cheat
 * gates (sanitized payloads, reveal-gate, host-only controls, answer dedupe) actually live.
 *
 * Prereqs: a running server (BASE_URL), and a deck marked ready with at least one slide
 * (two exercises navigation). Run:  npm run smoke
 */
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import postgres from 'postgres'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const DB_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL
if (!DB_URL) {
  console.error('Missing DIRECT_URL / DATABASE_URL in .env.local')
  process.exit(1)
}

let checks = 0
const ok = (label: string) => {
  checks++
  console.log(`  ✓ ${label}`)
}

// Module-scoped so a failed assertion can still close the room on the way out — a session
// left live keeps its deck locked for editing (lib/decks.ts).
let room: { code: string; hostToken: string } | null = null

const call = (
  path: string,
  opts: { method?: string; body?: unknown; token?: string } = {},
) =>
  fetch(`${BASE_URL}/api/sessions/${path}`, {
    method: opts.method ?? 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })

async function json(res: Response) {
  const text = await res.text()
  return { status: res.status, text, body: text ? JSON.parse(text) : null }
}

async function main() {
  const sql = postgres(DB_URL!, { prepare: false })
  // Two slides minimum: the navigation checks below are the point of the walk, and silently
  // skipping them on a one-slide deck would report a pass that never tested advance/back.
  const [deck] = await sql`
    select d.id, d.owner_id, count(s.id)::int as slides
    from decks d join slides s on s.deck_id = d.id
    where d.status = 'ready'
    group by d.id, d.owner_id
    having count(s.id) >= 2
    limit 1`
  if (!deck) {
    console.error('No ready deck with at least 2 slides. The navigation checks need two; add a slide and mark the deck ready.')
    process.exit(1)
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const hostToken = randomUUID()
  await sql`
    insert into sessions (deck_id, host_id, code, status, host_token)
    values (${deck.id}, ${deck.owner_id}, ${code}, 'lobby', ${hostToken})`
  await sql.end()
  room = { code, hostToken }
  console.log(`Session ${code} on deck ${deck.id} (${deck.slides} slides)\n`)

  // --- Lobby -------------------------------------------------------------------
  const joined = await json(await call(`${code}/join`, { body: { nickname: 'Alice' } }))
  assert.equal(joined.status, 200)
  assert.equal(joined.body.slide, null, 'lobby join must not hand out a slide')
  const alice = joined.body.clientToken as string
  assert.ok(alice, 'join issues a server-side client token')
  ok('join in the lobby: token issued, no slide yet')

  // A second player who deliberately never answers — used at the end to prove that
  // re-showing a revealed slide can't hand them the disclosed answer for points.
  const abstainer = (await json(await call(`${code}/join`, { body: { nickname: 'Abstainer' } })))
    .body.clientToken as string

  // --- Host-only controls ------------------------------------------------------
  assert.equal((await call(`${code}/advance`, { body: { index: 0 } })).status, 404)
  assert.equal((await call(`${code}/advance`, { body: { index: 0 }, token: randomUUID() })).status, 404)
  assert.equal((await call(`${code}/reveal`, { token: randomUUID() })).status, 404)
  assert.equal((await call(`${code}/end`, { token: randomUUID() })).status, 404)
  ok('advance/reveal/end reject a missing or wrong host token (404, no existence oracle)')

  assert.equal((await call(`${code}/advance`, { body: { index: 99 }, token: hostToken })).status, 400)
  assert.equal((await call(`${code}/advance`, { body: { index: -1 }, token: hostToken })).status, 400)
  assert.equal((await call(`${code}/advance`, { body: { index: 'x' }, token: hostToken })).status, 400)
  ok('advance rejects out-of-range and non-integer slide indexes')

  // --- Show the first slide ----------------------------------------------------
  const shown = await json(await call(`${code}/advance`, { body: { index: 0 }, token: hostToken }))
  assert.equal(shown.status, 200)
  assert.ok(!shown.text.includes('is_correct'), 'slide:show payload must never carry the answer key')
  const slide = shown.body.slide as { id: string; options: { id: string; text: string }[] }
  assert.ok(slide.options.length >= 2)
  ok('advance shows the slide, sanitized (no is_correct anywhere in the payload)')

  const beforeReveal = await json(await call(`${code}/state`, { method: 'GET', token: alice }))
  assert.equal(beforeReveal.body.status, 'active')
  assert.equal(beforeReveal.body.correctOptionId, null, '/state must not disclose the answer pre-reveal')
  assert.equal(beforeReveal.body.myOptionId, null)
  assert.ok(!beforeReveal.text.includes('is_correct'))
  ok('/state pre-reveal: slide present, correct option withheld')

  // --- Answering ---------------------------------------------------------------
  assert.equal((await call(`${code}/answer`, { body: { clientToken: alice, optionId: 'nope' } })).status, 400)
  assert.equal((await call(`${code}/answer`, { body: { optionId: slide.options[0].id } })).status, 400)
  assert.equal(
    (await call(`${code}/answer`, { body: { clientToken: randomUUID(), optionId: slide.options[0].id } })).status,
    403,
  )
  ok('answer rejects a bogus option, a missing token, and an unknown participant')

  const pick = slide.options[0].id
  const first = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: pick } }))
  assert.equal(first.body.accepted, true)
  assert.equal(first.body.alreadyAnswered, undefined)
  assert.ok(!('isCorrect' in first.body), 'own correctness must stay hidden until reveal')
  const second = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: slide.options[1].id } }))
  assert.equal(second.body.alreadyAnswered, true, 'one answer per participant per slide')
  ok('answer accepted once, deduped on re-submit, correctness withheld')

  const mid = await json(await call(`${code}/state`, { method: 'GET', token: alice }))
  assert.equal(mid.body.myOptionId, pick, '/state replays the caller’s own pick for reconnect')
  assert.equal(mid.body.correctOptionId, null)
  ok('/state replays this participant’s own answer, still no answer key')

  // --- Reveal ------------------------------------------------------------------
  const revealed = await json(await call(`${code}/reveal`, { token: hostToken }))
  assert.equal(revealed.status, 200)
  assert.ok(revealed.body.correctOptionId, 'reveal discloses the correct option')
  assert.equal(revealed.body.aggregate.total, 1, 'one of the two players answered')
  assert.equal(revealed.body.top.length, 2, 'both players are ranked, answered or not')
  ok('reveal discloses the answer, tallies responses, ranks the leaderboard')

  const late = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: pick } }))
  assert.equal(late.status, 409, 'the reveal-gate closes the answer window immediately')
  ok('answers are rejected after the reveal (no read-the-answer-then-submit window)')

  const afterReveal = await json(await call(`${code}/state`, { method: 'GET', token: alice }))
  assert.equal(afterReveal.body.correctOptionId, revealed.body.correctOptionId)
  ok('/state discloses the answer only once revealed')

  // --- Navigation --------------------------------------------------------------
  const next = await json(await call(`${code}/advance`, { body: { index: 1 }, token: hostToken }))
  assert.equal(next.status, 200)
  assert.notEqual(next.body.slide.id, slide.id)
  assert.equal(next.body.status, 'active', 'a fresh slide opens the answer window')
  const stale = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: pick } }))
  assert.equal(stale.status, 400, 'an answer aimed at the previous slide must not score')
  ok('advance moves on; an answer for the previous slide is rejected, not mis-scored')

  // Going Back to a slide whose key is already public must NOT reopen scoring. Left open,
  // anyone who sat that question out could submit the answer they watched being revealed.
  const back = await json(await call(`${code}/advance`, { body: { index: 0 }, token: hostToken }))
  assert.equal(back.body.slide.id, slide.id)
  assert.equal(back.body.status, 'revealed', 're-showing a revealed slide must stay revealed')
  assert.equal(back.body.correctOptionId, revealed.body.correctOptionId)
  const cheat = await json(
    await call(`${code}/answer`, {
      body: { clientToken: abstainer, optionId: revealed.body.correctOptionId },
    }),
  )
  assert.equal(cheat.status, 409, 'a player who sat the slide out must not score the disclosed answer')
  ok('Back re-shows a revealed slide with its results, and cannot reopen scoring')

  // --- End ---------------------------------------------------------------------
  const ended = await json(await call(`${code}/end`, { token: hostToken }))
  assert.equal(ended.status, 200)
  assert.ok(Array.isArray(ended.body.fullRanking))
  assert.equal((await call(`${code}/state`, { method: 'GET', token: alice })).status, 404)
  assert.equal((await call(`${code}/join`, { body: { nickname: 'Bob' } })).status, 404)
  ok('end closes the room: the code stops resolving for state and join')

  // An ended room must stay ended. Both transitions compare-and-set on status, so a request
  // that read the session before it closed can't write it back to active/revealed.
  assert.equal((await call(`${code}/advance`, { body: { index: 0 }, token: hostToken })).status, 404)
  assert.equal((await call(`${code}/reveal`, { token: hostToken })).status, 404)
  const check = postgres(DB_URL!, { prepare: false })
  const [after] = await check`select status from sessions where code = ${code}`
  await check.end()
  assert.equal(after.status, 'ended', 'nothing may resurrect an ended session')
  ok('advance/reveal cannot bring an ended session back to life')

  console.log(`\n${checks} checks passed.`)
  process.exit(0)
}

main().catch(async (e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e)
  if (room) await call(`${room.code}/end`, { token: room.hostToken }).catch(() => {})
  process.exit(1)
})
