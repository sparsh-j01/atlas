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
  // Joined over HTTP but never got a realtime connection. The signature of hitting the
  // project's concurrent-connection cap (200 on Free, 500 on Pro), which is a different
  // failure from a rejected join and has to be reported as its own number.
  let subscribeFailed = 0
  let presenceFailed = 0 // subscribed, but channel.track() came back non-'ok'
  const leaderboardLatency: number[] = []
  const gotLeaderboard: Array<() => void> = []
  const clients: SupabaseClient[] = []
  const subscribedIdx: number[] = [] // task indices that reached SUBSCRIBED (for the fan-out wait)

  // T0 for the fan-out measurement — stamped just before the single reveal call, read by
  // every client's leaderboard handler (shared closure; no per-channel plumbing).
  let revealSentAt = 0

  // --- Message-rate instrumentation -------------------------------------------------
  // Supabase counts and rate-limits Realtime per DELIVERED COPY: one broadcast to this room
  // is ~N+1 messages, not 1. The documented ceiling is 100 msg/s on Free and 500 on Pro, and
  // crossing it DISCONNECTS clients until throughput drops. So "did every client stay
  // connected" and "what was our peak messages/second" are the two numbers that decide
  // whether the 100+ claim holds — and neither was being measured. Bucketed by wall-clock
  // second across every client, which is the same unit the limit is expressed in.
  const msgsPerSecond = new Map<number, number>()
  const countMessage = () => {
    const bucket = Math.floor(Date.now() / 1000)
    msgsPerSecond.set(bucket, (msgsPerSecond.get(bucket) ?? 0) + 1)
  }
  // A client that drops mid-session and reconnects inside the 10s fan-out wait still
  // receives the leaderboard, so the old pass/fail could not see it. Record it instead.
  const drops: string[] = []
  // Host-only events seen on the ROOM channel. Any nonzero value means the channel split
  // regressed, whatever the latency numbers say.
  let hostOnlyOnRoom = 0
  // Closed only counts as a drop while the run is still measuring: teardown closes all N
  // channels deliberately, and without this gate a clean run reports N disconnects.
  let measuring = true

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
      // Every event this phone would receive counts toward the project's messages/second,
      // so count them all, not just the one the assertion waits on.
      for (const event of [EVENTS.SLIDE_SHOW, EVENTS.SLIDE_REVEAL, EVENTS.SESSION_ENDED]) {
        channel.on('broadcast', { event }, countMessage)
      }
      // ANSWERED_COUNT and RESULTS_UPDATE publish to the host channel and must never arrive
      // here. They stay subscribed because they are the two highest-frequency events in the
      // app and this harness is the only thing measuring the room's message rate — but
      // COUNTING a regression is not FAILING on one. Routed back onto the room channel they
      // could stay under the rate limit, disconnect nobody, and exit 0 with the whole point
      // of the split silently undone. Recorded separately, they fail the run outright.
      for (const event of [EVENTS.ANSWERED_COUNT, EVENTS.RESULTS_UPDATE]) {
        channel.on('broadcast', { event }, () => {
          countMessage()
          hostOnlyOnRoom++
        })
      }
      channel.on('broadcast', { event: EVENTS.LEADERBOARD_UPDATE }, () => {
        countMessage()
        if (revealSentAt) leaderboardLatency.push(Date.now() - revealSentAt)
        gotLeaderboard[i]?.()
      })
      let wasSubscribed = false
      let trackStatus: string | null = null
      // Bounded, because the thing this harness exists to find is a CEILING. Past the
      // project's concurrent-connection limit a subscribe never reaches SUBSCRIBED and never
      // errors either — it simply doesn't complete. An unbounded await here meant the run
      // hung forever at exactly the load worth measuring, which is the least useful possible
      // behaviour for a test whose job is locating the wall.
      const subscribed = await Promise.race([
        new Promise<boolean>((resolve) => {
          channel.subscribe((status) => {
            if (status === 'SUBSCRIBED') {
              if (!wasSubscribed) {
                wasSubscribed = true
                // track() RESOLVES with 'ok' | 'timed out' | 'error'. Firing it and resolving
                // in the same breath counted a client as present whose presence never
                // registered — and nothing else would have noticed, because the channel is
                // subscribed either way and broadcasts keep arriving. Presence is what the
                // lobby roster is built from, so an unmeasured failure here is a hole in the
                // one harness that exists to find this app's ceiling.
                channel
                  .track({ participantId, nickname, avatarSeed: nickname })
                  .then((s) => {
                    trackStatus = s
                    resolve(s === 'ok')
                  })
                  .catch(() => {
                    trackStatus = 'error'
                    resolve(false)
                  })
              } else {
                // Back after a drop. Silent today, and it is exactly what exceeding the
                // messages/second limit looks like from the client side.
                drops.push(`${nickname} re-SUBSCRIBED`)
              }
            } else if (measuring && wasSubscribed && (status === 'CHANNEL_ERROR' || status === 'CLOSED')) {
              drops.push(`${nickname} → ${status}`)
            }
          })
        }),
        new Promise<boolean>((r) => setTimeout(() => r(false), 20_000)),
      ])
      if (!subscribed) {
        // Split the two, because they mean different things about the ceiling: never reaching
        // SUBSCRIBED points at the connection cap, a non-'ok' track points at the Presence
        // limit. Reported, not failed on — locating those caps is what this harness is for.
        if (trackStatus && trackStatus !== 'ok') presenceFailed++
        else subscribeFailed++
        return // not in the room, so no answer either
      }
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
  measuring = false // everything after this point is teardown, not the run

  console.log('\n--- Results ---')
  console.log(`Join success:        ${joinOk}/${N} (${((100 * joinOk) / N).toFixed(1)}%)`)
  console.log(
    `Realtime connected:  ${subscribedIdx.length}/${joinOk}` +
      `${subscribeFailed ? `  (${subscribeFailed} never connected — connection cap?)` : ''}` +
      `${presenceFailed ? `  (${presenceFailed} connected but Presence track failed — Presence limit?)` : ''}`,
  )
  console.log(`Answers accepted:    ${answerOk}/${joinOk}`)
  console.log(`Leaderboard fan-out: ${leaderboardLatency.length}/${joinOk} clients received`)
  console.log(`  p50: ${pctl(leaderboardLatency, 50)} ms`)
  console.log(`  p95: ${pctl(leaderboardLatency, 95)} ms`)
  console.log(`  max: ${Math.max(...leaderboardLatency, 0)} ms`)

  // The number that decides whether this scales, measured rather than assumed. Free allows
  // 100 msg/s, Pro 500; over the limit Supabase disconnects clients until the rate drops.
  // Counted client-side, so it is the delivered copies only — the server's own publishes add
  // one per broadcast on top, which is why the ceiling comparison uses this as a floor.
  const totalMsgs = [...msgsPerSecond.values()].reduce((a, b) => a + b, 0)
  const peak = Math.max(0, ...msgsPerSecond.values())
  console.log(`Realtime messages:   ${totalMsgs} delivered, peak ${peak}/s across ${joinOk} clients`)
  console.log(`  vs plan limits:    Free 100/s · Pro 500/s (exceeding either disconnects clients)`)
  if (drops.length) {
    console.log(`  DISCONNECTS:       ${drops.length} — ${drops.slice(0, 5).join(', ')}`)
  }

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
  // A run where clients dropped is not a pass, however good the latency numbers look — the
  // fan-out wait is 10s, which is long enough for a dropped client to reconnect and receive
  // the leaderboard anyway. That is what made this failure invisible before.
  if (drops.length || hostOnlyOnRoom) {
    if (drops.length) {
      console.error(`\nFAILED: ${drops.length} client(s) left the channel mid-session.`)
    }
    if (hostOnlyOnRoom) {
      console.error(
        `\nFAILED: ${hostOnlyOnRoom} host-only message(s) reached the room channel — ` +
          `answered:count / results:update are billed per phone, and the split regressed.`,
      )
    }
    process.exit(1)
  }
  process.exit(0)
}

main().catch(async (e) => {
  console.error(e)
  await teardown()
  process.exit(1)
})
