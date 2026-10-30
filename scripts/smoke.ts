/**
 * Live-session acceptance walk — the M3 "done when" proof, and the check that fails if a
 * later change loosens one of the guards. Unit tests cover the pure logic; this one drives
 * the real HTTP routes against a real database, because that's the only place the anti-cheat
 * gates (sanitized payloads, deadline progression, host-only controls, answer dedupe, the
 * post-quiz review) actually live.
 *
 * Prereqs: a running server (BASE_URL). The deck it runs on is created here (scripts/fixture),
 * so there's nothing to set up by hand and nothing of yours it can touch. Run:  npm run smoke
 */
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import postgres from 'postgres'
import { createFixtureDeck, dropFixtureDeckIfIdle, sweepStaleFixtures } from './fixture'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const DB_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL
if (!DB_URL) {
  console.error('Missing DIRECT_URL in .env.local')
  process.exit(1)
}

let checks = 0
const ok = (label: string) => {
  checks++
  console.log(`  ✓ ${label}`)
}

// Module-scoped so a failed assertion can still close the room and drop the fixture deck on
// the way out — a session left live keeps its deck locked for editing (lib/decks.ts).
let room: { code: string; hostToken: string } | null = null
let fixtureDeckId: string | null = null
const sql = postgres(DB_URL!, { prepare: false })

async function teardown() {
  try {
    if (room) await call(`${room.code}/end`, { token: room.hostToken })
    // Deck goes only if the room actually closed — see dropFixtureDeckIfIdle.
    if (fixtureDeckId) await dropFixtureDeckIfIdle(sql, fixtureDeckId)
  } catch {
    // Best effort: whatever is left standing gets swept at the start of the next run.
  }
  await sql.end().catch(() => {})
}

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
  // Clear anything a previously interrupted run left behind (its own fixtures only), then
  // build this run's deck. Two questions, so the walk sees the deadline move the room on
  // AND end it, and a streak carry from one question to the next. 4 s each keeps it quick.
  await sweepStaleFixtures(sql, async (code, token) =>
    (await call(`${code}/end`, { token })).ok,
  )
  const { deckId, ownerId } = await createFixtureDeck(sql, {
    types: ['quiz_mcq', 'quiz_mcq'],
    timeLimitMs: 4_000,
  })
  fixtureDeckId = deckId

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const hostToken = randomUUID()
  await sql`
    insert into sessions (deck_id, host_id, code, status, host_token)
    values (${deckId}, ${ownerId}, ${code}, 'lobby', ${hostToken})`
  room = { code, hostToken }
  console.log(`Session ${code} on fixture deck ${deckId} (quiz · quiz)\n`)

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

  // --- Nickname guard + kick ----------------------------------------------------
  // The name a stranger types lands on a projector in front of a room, so the filter runs
  // server-side; and because any filter is beatable, the host gets a removal control. Both
  // halves are checked here — the filter on a padded spelling it must still catch, and the
  // kick on a player who got in anyway.
  assert.equal((await call(`${code}/join`, { body: { nickname: 'xX_fUuUcK_Xx' } })).status, 400)
  assert.equal((await call(`${code}/join`, { body: { nickname: '   ' } })).status, 400)
  ok('join rejects a blocked nickname through padding, repeats and case')

  const griefer = await json(await call(`${code}/join`, { body: { nickname: 'Rude Name' } }))
  const grieferId = griefer.body.participantId as string
  const grieferToken = griefer.body.clientToken as string
  assert.equal(
    (await call(`${code}/kick`, { body: { participantId: grieferId }, token: randomUUID() })).status,
    404,
    'kick is host-only, and a wrong token must not confirm the room exists',
  )
  assert.equal((await call(`${code}/kick`, { body: {}, token: hostToken })).status, 400)
  assert.equal(
    (await call(`${code}/kick`, { body: { participantId: 'not-a-uuid' }, token: hostToken }))
      .status,
    400,
    'a malformed id is a bad request, not a uuid cast error surfacing as a 500',
  )
  assert.equal(
    (await call(`${code}/kick`, { body: { participantId: randomUUID() }, token: hostToken })).status,
    404,
    'kicking someone who is not in this room is a miss, not a silent success',
  )
  assert.equal(
    (await call(`${code}/kick`, { body: { participantId: grieferId }, token: hostToken })).status,
    200,
  )
  // Removed for real, not flagged: their seat is gone from both the read and the write path.
  assert.equal((await call(`${code}/state`, { method: 'GET', token: grieferToken })).status, 404)
  ok('host can remove a player; their token stops resolving immediately')

  // --- Host-only controls ------------------------------------------------------
  assert.equal((await call(`${code}/advance`, { body: { index: 0 } })).status, 404)
  assert.equal((await call(`${code}/advance`, { body: { index: 0 }, token: randomUUID() })).status, 404)
  assert.equal((await call(`${code}/end`, { token: randomUUID() })).status, 404)
  ok('start/end reject a missing or wrong host token (404, no existence oracle)')

  // --- Start: the first question -------------------------------------------------
  const shown = await json(await call(`${code}/advance`, { body: { index: 0 }, token: hostToken }))
  assert.equal(shown.status, 200)
  assert.ok(!shown.text.includes('is_correct'), 'slide:show payload must never carry the answer key')
  assert.ok(!shown.text.includes('explanation'), 'nor the explanation, which names the answer')
  const slide = shown.body.slide as { id: string; options: { id: string; text: string }[] }
  const q1 = { index: 0, serverStartedAt: shown.body.serverStartedAt as string }
  assert.ok(slide.options.length >= 2)
  assert.equal(shown.body.total, 2)
  ok('start shows question 1, sanitized (no answer key, no explanation)')
  assert.equal((await call(`${code}/advance`, { body: { index: 0 }, token: hostToken })).status, 409)
  ok('a second start is refused: a running room cannot be restarted')

  const fresh = await json(await call(`${code}/state`, { method: 'GET', token: alice }))
  assert.equal(fresh.body.status, 'active')
  assert.equal(fresh.body.myOptionId, null)
  assert.ok(!fresh.text.includes('is_correct') && !('correctOptionId' in fresh.body), '/state has no answer key mid-quiz')
  ok('/state mid-question: question present, no answer key')

  // A token from some other (or older) room must not read this one. Codes get recycled once
  // a session ends, so a phone that was offline at the close still holds a token for a code
  // that now belongs to a different game — it used to get 200 and render this room's slides.
  assert.equal((await call(`${code}/state`, { method: 'GET', token: randomUUID() })).status, 404)
  ok('/state rejects a token that names nobody in this session (recycled-code phones)')
  // Room-code scanning: someone with no seat must not be able to tell a live code from a dead
  // one. /state with no token used to return the live room — question included.
  assert.equal((await call(`${code}/state`, { method: 'GET' })).status, 404)
  ok('/state with no token is the same 404 as an unknown code')

  // --- Answering ---------------------------------------------------------------
  assert.equal((await call(`${code}/answer`, { body: { clientToken: alice, optionId: 'nope' } })).status, 400)
  assert.equal((await call(`${code}/answer`, { body: { optionId: slide.options[0].id } })).status, 400)
  assert.equal(
    (await call(`${code}/answer`, { body: { clientToken: randomUUID(), optionId: slide.options[0].id } })).status,
    403,
  )
  ok('answer rejects a bogus option, a missing token, and an unknown participant')
  // Same answer for "no such room" as for "not in this room", while a question is OPEN — that
  // is when the old order leaked (400 from a live room, 409 from a dead code).
  assert.equal(
    (await call(`000000/answer`, { body: { clientToken: randomUUID(), optionId: slide.options[0].id } })).status,
    403,
  )
  ok('answer gives an unknown code the same 403 as an unknown participant')

  const pick = slide.options[0].id // fixture marks option A correct
  const first = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: pick } }))
  assert.equal(first.body.accepted, true)
  assert.equal(first.body.alreadyAnswered, undefined)
  assert.ok(!('isCorrect' in first.body), 'own correctness stays hidden until the review')
  const second = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: slide.options[1].id } }))
  assert.equal(second.body.alreadyAnswered, true, 'one answer per participant per slide')
  ok('answer accepted once, deduped on re-submit, correctness withheld')

  const mid = await json(await call(`${code}/state`, { method: 'GET', token: alice }))
  assert.equal(mid.body.myOptionId, pick, '/state replays the caller’s own pick for reconnect')
  ok('/state replays this participant’s own answer')

  // --- Deadline progression ------------------------------------------------------
  // Early: a phone whose clock runs fast wakes before the deadline. The server answers with
  // how long is left by ITS clock and moves nothing.
  const early = await json(await call(`${code}/progress`, { body: q1, token: alice }))
  assert.equal(early.status, 200)
  assert.ok(early.body.waitMs > 0, 'an early wake is told how long is left')
  ok('an early wake is told to wait, by the server clock, and moves nothing')
  // A wake naming a question that is not the live one catches the caller up instead.
  const wrong = await json(await call(`${code}/progress`, { body: { ...q1, index: 1 }, token: alice }))
  assert.equal(wrong.body.index, 0, 'a wake for the wrong question cannot skip ahead')
  assert.equal((await call(`${code}/progress`, { body: q1, token: randomUUID() })).status, 404)
  ok('a wake for the wrong question cannot skip, and a stranger cannot wake the room')

  await new Promise((r) => setTimeout(r, early.body.waitMs + 100))
  const moved = await json(await call(`${code}/progress`, { body: q1, token: hostToken }))
  assert.equal(moved.status, 200)
  assert.equal(moved.body.index, 1, 'the deadline moves the room to question 2')
  assert.ok(!moved.text.includes('is_correct') && !moved.text.includes('explanation'))
  const q2 = { index: 1, serverStartedAt: moved.body.serverStartedAt as string }
  const again = await json(await call(`${code}/progress`, { body: q1, token: alice }))
  assert.equal(again.body.index, 1, 'a late duplicate wake for question 1 changes nothing')
  ok('at the deadline the room moves on exactly once, still with no answer key')

  const stale = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: pick } }))
  assert.equal(stale.status, 400, 'an answer aimed at the closed question must not score')
  ok('an answer for the closed question is rejected, not mis-scored')

  // --- Question 2: a second correct answer extends the streak --------------------------
  // Read straight off the row rather than inferred from the formula.
  const aliceRow = async () => {
    const [r] = await sql<{ score: number; streak: number }[]>`
      select p.score, p.streak from participants p
      join sessions s on s.id = p.session_id
      where s.code = ${code} and p.client_token = ${alice}`
    return r
  }
  const afterFirst = await aliceRow()
  assert.equal(afterFirst.streak, 1, 'the first question was answered correctly, so a streak is running')
  const secondPick = (moved.body.slide.options as { id: string }[])[0].id
  const scored = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: secondPick } }))
  assert.equal(scored.body.accepted, true)
  const afterSecond = await aliceRow()
  assert.equal(afterSecond.streak, 2, 'consecutive correct answers extend the streak')
  assert.ok(afterSecond.score > afterFirst.score, 'and score')
  ok('a second correct answer scores and extends the streak')

  // --- The last deadline ends the quiz --------------------------------------------
  await new Promise((r) => setTimeout(r, Date.parse(q2.serverStartedAt) + 4_000 + 850 - Date.now()))
  const ended = await json(await call(`${code}/progress`, { body: q2, token: abstainer }))
  assert.equal(ended.body.status, 'ended', 'any seat may wake the final deadline, and it ends the quiz')
  assert.ok(Array.isArray(ended.body.leaderboard))
  ok('the last question\'s deadline ends the session on its own')

  // After the end, a seat's /state is its own answer review (the answer key is public now);
  // a token that names nobody here still gets the same 404 as an unknown code.
  const review = await json(await call(`${code}/state`, { method: 'GET', token: alice }))
  assert.equal(review.status, 200)
  assert.equal(review.body.status, 'ended')
  assert.equal(review.body.review?.correct, 2, 'the review grades this seat\'s own two answers')
  const sat = await json(await call(`${code}/state`, { method: 'GET', token: abstainer }))
  assert.equal(sat.body.review?.unanswered, 2, 'a seat that answered nothing sees both as unanswered')
  assert.equal((await call(`${code}/state`, { method: 'GET', token: randomUUID() })).status, 404)
  assert.equal((await call(`${code}/join`, { body: { nickname: 'Bob' } })).status, 404)
  ok('end closes the room to joins; each seat gets its own review, anyone else a 404')

  // An ended room must stay ended: start compare-and-sets on 'lobby', and progression only
  // moves a live question.
  assert.equal((await call(`${code}/advance`, { body: { index: 0 }, token: hostToken })).status, 404)
  assert.equal((await call(`${code}/answer`, { body: { clientToken: alice, optionId: secondPick } })).status, 403)
  const [after] = await sql`select status from sessions where code = ${code}`
  assert.equal(after.status, 'ended', 'nothing may resurrect an ended session')
  ok('nothing brings an ended session back to life')
  room = null // proven ended above; teardown only needs to drop the fixture deck now

  console.log(`\n${checks} checks passed.`)
  await teardown()
  process.exit(0)
}

main().catch(async (e) => {
  console.error('\nFAILED:', e instanceof Error ? e.message : e)
  await teardown()
  process.exit(1)
})
