/**
 * Load test — the "prove 100+ concurrent" artifact.
 *
 * Spins up N simulated participants, each its own Supabase Realtime connection (so this
 * is a real concurrency test, not N channels on one socket). They join over HTTP, answer
 * the live slide, then the host reveals and we measure how long the leaderboard broadcast
 * takes to fan out to every client.
 *
 * The room is hosted over HTTP with the session's host token (`Authorization: Bearer`) —
 * the same routes the browser console uses, where the token rides an httpOnly cookie
 * instead. The session row is created here directly, because launching from the app needs
 * a signed-in creator; the deck it runs on is created here too (scripts/fixture).
 *
 * Prereqs: a running server (BASE_URL) and a live Supabase project (URL + anon key).
 * Run:  npx tsx scripts/loadtest.ts [N]
 */
import { randomInt, randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import postgres from 'postgres'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { openSessionChannel } from '../lib/realtime/channels'
import { EVENTS } from '../lib/realtime/events'
import { createFixtureDeck, dropFixtureDeckIfIdle, sweepStaleFixtures } from './fixture'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const DB_URL = process.env.DIRECT_URL ?? process.env.DATABASE_URL
const N = Number(process.argv[2] ?? process.env.LOADTEST_N ?? 120)

if (!SUPABASE_URL || !ANON || !DB_URL) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY / DIRECT_URL in .env.local')
  process.exit(1)
}
// Number() takes NaN, 0, negatives and fractions, and Array.from({length: NaN}) is empty —
// a typo would otherwise "pass" with zero clients and NaN percentiles.
if (!Number.isInteger(N) || N < 1) {
  console.error(`Client count must be a positive integer (got "${process.argv[2] ?? process.env.LOADTEST_N}").`)
  process.exit(1)
}

// Module-scoped so any exit path can close the room and drop the fixture deck. A session
// left live keeps its deck locked for editing (lib/decks.ts), so bailing out early must not
// strand it.
let room: { code: string; hostToken: string } | null = null
let fixtureDeckId: string | null = null
const sql = postgres(DB_URL!, { prepare: false })

const teardown = async () => {
  try {
    if (room) {
      await post(`/api/sessions/${room.code}/end`, undefined, room.hostToken)
      room = null
    }
    // Deck goes only if the room actually closed — see dropFixtureDeckIfIdle.
    if (fixtureDeckId) await dropFixtureDeckIfIdle(sql, fixtureDeckId)
  } catch {
    // Best effort: whatever is left standing gets swept at the start of the next run.
  }
  await sql.end().catch(() => {})
}

const pctl = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const post = (path: string, body?: unknown, hostToken?: string) =>
  fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(hostToken ? { Authorization: `Bearer ${hostToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function main() {
  console.log(`Load test: ${N} clients → ${BASE_URL}`)

  // Host a session on a deck this run owns. Straight SQL rather than lib/sessions.ts: that
  // module is `server-only`, which throws the moment it's imported outside a server runtime.
  await sweepStaleFixtures(sql, async (c, token) =>
    (await post(`/api/sessions/${c}/end`, undefined, token)).ok,
  )
  const { deckId, ownerId } = await createFixtureDeck(sql, { types: ['quiz_mcq'] })
  fixtureDeckId = deckId

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const hostToken = randomUUID()
  await sql`
    insert into sessions (deck_id, host_id, code, status, host_token)
    values (${deckId}, ${ownerId}, ${code}, 'lobby', ${hostToken})`
  room = { code, hostToken } // registered immediately, so every later exit path can close it

  // Show the first slide — this is what opens the answer window and starts the server clock.
  const shown = await post(`/api/sessions/${code}/advance`, { index: 0 }, hostToken)
  if (!shown.ok) {
    console.error(`advance failed (${shown.status}): ${await shown.text()}`)
    await teardown()
    process.exit(1)
  }
  const { slide, timeLimitMs } = (await shown.json()) as {
    slide: { options: { id: string }[] }
    timeLimitMs: number
  }
  const optionIds = slide.options.map((o) => o.id)
  console.log(`Session ${code} live on fixture deck ${deckId} — ${optionIds.length} options.`)

  let joinOk = 0
  let answerOk = 0
  const leaderboardLatency: number[] = []
  const gotLeaderboard: Array<() => void> = []
  const clients: SupabaseClient[] = []
  const subscribedIdx: number[] = [] // task indices that reached SUBSCRIBED (for the fan-out wait)

  // T0 for the fan-out measurement — stamped just before the single reveal call, read by
  // every client's leaderboard handler (shared closure; no per-channel plumbing).
  let revealSentAt = 0

  await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      const nickname = `bot-${i}`
      let clientToken: string
      let participantId: string
      try {
        const j = await post(`/api/sessions/${code}/join`, { nickname })
        if (!j.ok) return
        const data = await j.json()
        clientToken = data.clientToken
        participantId = data.participantId
        joinOk++
      } catch {
        return
      }

      const supabase = createClient(SUPABASE_URL!, ANON!)
      clients.push(supabase)
      const channel = openSessionChannel(supabase, code)
      channel.on('broadcast', { event: EVENTS.LEADERBOARD_UPDATE }, () => {
        if (revealSentAt) leaderboardLatency.push(Date.now() - revealSentAt)
        gotLeaderboard[i]?.()
      })
      await new Promise<void>((resolve) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            channel.track({ participantId, nickname, avatarSeed: nickname })
            resolve()
          }
        })
      })
      subscribedIdx.push(i)

      // Answer at a human-ish random moment inside the window.
      await new Promise((r) => setTimeout(r, randomInt(Math.min(timeLimitMs - 2000, 6000))))
      const a = await post(`/api/sessions/${code}/answer`, {
        clientToken,
        optionId: optionIds[randomInt(optionIds.length)],
      }).then((r) => r.json())
      if (a?.accepted) answerOk++
    }),
  )

  console.log(`Joined ${joinOk}/${N}, answers accepted ${answerOk}/${joinOk}. Revealing…`)

  // Key the resolvers by the SAME task index the broadcast handler uses (gotLeaderboard[i]).
  // `clients` is push-ordered by join-completion, so clients.map's index diverged from `i`
  // and most `done` promises never resolved — the wait always hit the 10s cap.
  const done = subscribedIdx.map((i) => new Promise<void>((resolve) => (gotLeaderboard[i] = resolve)))
  revealSentAt = Date.now()
  // fetch() resolves on HTTP errors, so an unchecked reveal turns a broken run into a
  // "0 clients received" result that still exits 0 — the run has to fail loudly instead.
  const revealed = await post(`/api/sessions/${code}/reveal`, undefined, hostToken)
  if (!revealed.ok) {
    console.error(`reveal failed (${revealed.status}): ${await revealed.text()}`)
    await teardown()
    process.exit(1)
  }

  // Wait for the fan-out (10s cap).
  await Promise.race([Promise.all(done), new Promise((r) => setTimeout(r, 10_000))])

  console.log('\n--- Results ---')
  console.log(`Join success:        ${joinOk}/${N} (${((100 * joinOk) / N).toFixed(1)}%)`)
  console.log(`Answers accepted:    ${answerOk}/${joinOk}`)
  console.log(`Leaderboard fan-out: ${leaderboardLatency.length}/${joinOk} clients received`)
  console.log(`  p50: ${pctl(leaderboardLatency, 50)} ms`)
  console.log(`  p95: ${pctl(leaderboardLatency, 95)} ms`)
  console.log(`  max: ${Math.max(...leaderboardLatency, 0)} ms`)

  // End the room, then drop the fixture deck this run created.
  const ended = await post(`/api/sessions/${code}/end`, undefined, hostToken)
  room = null
  clients.forEach((c) => c.removeAllChannels())
  if (!ended.ok) {
    console.error(`\nend failed (${ended.status}): ${await ended.text()} — the room is still live.`)
    // teardown leaves the deck alone while that room is open, so the next sweep can retry.
    await teardown()
    process.exit(1)
  }
  await teardown()
  process.exit(0)
}

main().catch(async (e) => {
  console.error(e)
  await teardown()
  process.exit(1)
})
