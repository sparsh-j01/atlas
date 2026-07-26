/**
 * Live-session acceptance walk — the M3 "done when" proof, and the check that fails if a
 * later change loosens one of the guards. Unit tests cover the pure logic; this one drives
 * the real HTTP routes against a real database, because that's the only place the anti-cheat
 * gates (sanitized payloads, reveal-gate, host-only controls, answer dedupe) actually live.
 *
 * Prereqs: a running server (BASE_URL). The deck it runs on is created here (scripts/fixture),
 * so there's nothing to set up by hand and nothing of yours it can touch. Run:  npm run smoke
 */
import assert from 'node:assert/strict'
import { randomInt, randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import postgres from 'postgres'
import { createClient } from '@supabase/supabase-js'
import { openSessionChannel } from '../lib/realtime/channels'
import { EVENTS, type AnsweredCountPayload, type ResultsUpdatePayload } from '../lib/realtime/events'
import { createFixtureDeck, dropFixtureDeckIfIdle, sweepStaleFixtures } from './fixture'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const DB_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
// Asserted, never skipped: the broadcast checks below are the only coverage the live poll
// feed has, and a walk that quietly dropped them would still print "all checks passed".
if (!DB_URL || !SUPABASE_URL || !ANON) {
  console.error(
    'Missing DIRECT_URL / NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local',
  )
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
const supabase = createClient(SUPABASE_URL!, ANON!)

async function teardown() {
  try {
    if (room) await call(`${room.code}/end`, { token: room.hostToken })
    // Deck goes only if the room actually closed — see dropFixtureDeckIfIdle.
    if (fixtureDeckId) await dropFixtureDeckIfIdle(sql, fixtureDeckId)
  } catch {
    // Best effort: whatever is left standing gets swept at the start of the next run.
  }
  await supabase.removeAllChannels().catch(() => {})
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

// Broadcasts observed on the session channel over the anon key — exactly what a participant's
// phone receives. The rest of the walk is pure HTTP; this is the only place it can check what
// the room was actually told, which is where the live-viz rules live.
const seen: { event: string; payload: unknown }[] = []
const countOf = (event: string) => seen.filter((s) => s.event === event).length

async function waitForEvent(event: string, ms = 5_000): Promise<unknown | null> {
  const deadline = Date.now() + ms
  for (;;) {
    const hit = seen.find((s) => s.event === event)
    if (hit) return hit.payload
    if (Date.now() >= deadline) return null
    await new Promise((r) => setTimeout(r, 50))
  }
}

async function main() {
  // Clear anything a previously interrupted run left behind (its own fixtures only), then
  // build this run's deck. Three slides, and deliberately mixed: the navigation checks are
  // the point of the walk (silently skipping them on a one-slide deck would report a pass
  // that never tested advance/back), and the unscored poll sits BETWEEN two scored questions
  // so the walk can prove a poll doesn't score and doesn't break a streak it sits inside of.
  await sweepStaleFixtures(sql, async (code, token) =>
    (await call(`${code}/end`, { token })).ok,
  )
  const { deckId, ownerId } = await createFixtureDeck(sql, {
    types: ['quiz_mcq', 'poll', 'quiz_mcq'],
  })
  fixtureDeckId = deckId

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const hostToken = randomUUID()
  await sql`
    insert into sessions (deck_id, host_id, code, status, host_token)
    values (${deckId}, ${ownerId}, ${code}, 'lobby', ${hostToken})`
  room = { code, hostToken }
  console.log(`Session ${code} on fixture deck ${deckId} (quiz · poll · quiz)\n`)

  // Listen in as a participant does. Subscribed before the first answer so the walk can
  // assert on what was NOT sent as well as what was — a check that only ever waits for an
  // event can't catch a tally leaking out of a live quiz.
  const channel = openSessionChannel(supabase, code)
  for (const event of [EVENTS.ANSWERED_COUNT, EVENTS.RESULTS_UPDATE]) {
    channel.on('broadcast', { event }, ({ payload }) => seen.push({ event, payload }))
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session channel never subscribed')), 10_000)
    channel.subscribe((s) => {
      if (s === 'SUBSCRIBED') {
        clearTimeout(timer)
        resolve()
      } else if (s === 'CHANNEL_ERROR' || s === 'TIMED_OUT') {
        clearTimeout(timer)
        reject(new Error(`session channel failed to subscribe: ${s}`))
      }
    })
  })

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

  // The anti-herding rule, checked on the wire rather than inferred from the route: a live
  // quiz may broadcast HOW MANY have answered, never WHAT they answered.
  const counted = (await waitForEvent(EVENTS.ANSWERED_COUNT)) as AnsweredCountPayload | null
  assert.ok(counted, 'a quiz answer broadcasts a live answered-count')
  assert.equal(counted.slideId, slide.id)
  assert.equal(counted.answered, 1)
  assert.equal(
    countOf(EVENTS.RESULTS_UPDATE),
    0,
    'a live quiz must never broadcast its tally — the room would herd toward the leading answer',
  )
  ok('quiz answer broadcasts a bare count, never the running distribution')

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

  // --- Poll (slide 2): unscored, and no answer key exists to leak ---------------
  const poll = next.body.slide as {
    id: string
    type: string
    points: number
    chart?: string
    options: { id: string }[]
  }
  assert.equal(poll.type, 'poll')
  assert.equal(poll.chart, 'donut', 'the chart kind rides the sanitized slide so the room can draw it')
  assert.equal(poll.points, 0, 'an unscored slide advertises no points')
  assert.ok(!next.text.includes('is_correct'), 'a poll payload has no answer key, same as a quiz')
  ok('advance shows the poll: chart kind present, points zero, no answer key')

  // Read the score/streak straight off the row rather than inferring from the formula — the
  // invariant is "the poll changed neither", and that is what the column says.
  const aliceRow = async () => {
    const [r] = await sql<{ score: number; streak: number }[]>`
      select p.score, p.streak from participants p
      join sessions s on s.id = p.session_id
      where s.code = ${code} and p.client_token = ${alice}`
    return r
  }
  const beforeVote = await aliceRow()
  assert.equal(beforeVote.streak, 1, 'the first question was answered correctly, so a streak is running')

  seen.length = 0 // only this slide's broadcasts from here on
  const vote = await json(
    await call(`${code}/answer`, { body: { clientToken: alice, optionId: poll.options[1].id } }),
  )
  assert.equal(vote.body.accepted, true, 'a poll vote is accepted like any other response')
  assert.ok(!('isCorrect' in vote.body))
  const afterVote = await aliceRow()
  assert.equal(afterVote.score, beforeVote.score, 'a poll vote awards no points')
  // The cross-type bug this whole slide arrangement exists to catch: routing a poll through
  // the scoring path would score it as "wrong" and reset the streak to 0.
  assert.equal(afterVote.streak, beforeVote.streak, 'a poll must not break a quiz streak')
  ok('poll vote recorded: no points awarded, streak left intact')

  // The M5 headline, on the wire: a poll publishes the distribution WHILE the window is
  // still open. This is the results:update path M4 left deliberately unused.
  const live = (await waitForEvent(EVENTS.RESULTS_UPDATE)) as ResultsUpdatePayload | null
  assert.ok(live, 'a poll vote broadcasts the live distribution')
  assert.equal(live.slideId, poll.id)
  assert.equal(live.aggregate.total, 1)
  assert.equal(live.aggregate.counts[poll.options[1].id], 1, 'and it counts the option actually chosen')
  assert.equal(
    countOf(EVENTS.ANSWERED_COUNT),
    0,
    'a poll sends the distribution instead of the bare count — not both',
  )
  ok('poll broadcasts results:update live, while voting is still open')

  const pollClose = await json(await call(`${code}/reveal`, { token: hostToken }))
  assert.equal(pollClose.status, 200)
  assert.equal(pollClose.body.correctOptionId, null, 'a poll has no answer to disclose')
  assert.equal(pollClose.body.explanation, undefined)
  assert.ok(!pollClose.text.includes('is_correct'))
  assert.equal(pollClose.body.aggregate.total, 1, 'the vote is in the published tally')
  assert.equal(pollClose.body.aggregate.counts[poll.options[1].id], 1, 'and against the option chosen')
  const pollState = await json(await call(`${code}/state`, { method: 'GET', token: alice }))
  assert.equal(pollState.body.correctOptionId, null, '/state must not invent an answer key for a poll')
  assert.equal(pollState.body.myOptionId, poll.options[1].id, '/state replays a poll vote too')
  ok('closing a poll publishes the tally and still discloses no answer')

  // --- Slide 3 (quiz): the streak survived the unscored slide -------------------
  const third = await json(await call(`${code}/advance`, { body: { index: 2 }, token: hostToken }))
  assert.equal(third.status, 200)
  assert.equal(third.body.status, 'active')
  const thirdPick = (third.body.slide.options as { id: string }[])[0].id // fixture marks option A correct
  const scored = await json(await call(`${code}/answer`, { body: { clientToken: alice, optionId: thirdPick } }))
  assert.equal(scored.body.accepted, true)
  const afterThird = await aliceRow()
  assert.equal(afterThird.streak, 2, 'the streak continues across the poll instead of restarting at 1')
  assert.ok(afterThird.score > afterVote.score, 'a correct answer after a poll still scores')
  ok('a scored question after a poll keeps the streak running')

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
  const [after] = await sql`select status from sessions where code = ${code}`
  assert.equal(after.status, 'ended', 'nothing may resurrect an ended session')
  ok('advance/reveal cannot bring an ended session back to life')
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
