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
 * a signed-in creator: pick any of their ready decks and host it.
 *
 * Prereqs: a running server (BASE_URL), a live Supabase project (URL + anon key), and at
 * least one deck marked ready with a slide on it. Run:  npx tsx scripts/loadtest.ts [N]
 */
import { randomInt, randomUUID } from 'node:crypto'
import { config } from 'dotenv'
import postgres from 'postgres'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { openSessionChannel } from '../lib/realtime/channels'
import { EVENTS } from '../lib/realtime/events'

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

  // Host a session on any ready deck. Straight SQL rather than lib/sessions.ts: that module
  // is `server-only`, which throws the moment it's imported outside a server runtime.
  const sql = postgres(DB_URL!, { prepare: false })
  const [deck] = await sql`
    select d.id, d.owner_id
    from decks d
    where d.status = 'ready' and exists (select 1 from slides s where s.deck_id = d.id)
    limit 1`
  if (!deck) {
    console.error('No ready deck with slides. Create one in the app (and mark it ready) first.')
    process.exit(1)
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
  const hostToken = randomUUID()
  await sql`
    insert into sessions (deck_id, host_id, code, status, host_token)
    values (${deck.id}, ${deck.owner_id}, ${code}, 'lobby', ${hostToken})`
  await sql.end()

  // Show the first slide — this is what opens the answer window and starts the server clock.
  const shown = await post(`/api/sessions/${code}/advance`, { index: 0 }, hostToken)
  if (!shown.ok) {
    console.error(`advance failed (${shown.status}): ${await shown.text()}`)
    process.exit(1)
  }
  const { slide, timeLimitMs } = (await shown.json()) as {
    slide: { options: { id: string }[] }
    timeLimitMs: number
  }
  const optionIds = slide.options.map((o) => o.id)
  console.log(`Session ${code} live on deck ${deck.id} — ${optionIds.length} options.`)

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
  await post(`/api/sessions/${code}/reveal`, undefined, hostToken)

  // Wait for the fan-out (10s cap).
  await Promise.race([Promise.all(done), new Promise((r) => setTimeout(r, 10_000))])

  console.log('\n--- Results ---')
  console.log(`Join success:        ${joinOk}/${N} (${((100 * joinOk) / N).toFixed(1)}%)`)
  console.log(`Answers accepted:    ${answerOk}/${joinOk}`)
  console.log(`Leaderboard fan-out: ${leaderboardLatency.length}/${joinOk} clients received`)
  console.log(`  p50: ${pctl(leaderboardLatency, 50)} ms`)
  console.log(`  p95: ${pctl(leaderboardLatency, 95)} ms`)
  console.log(`  max: ${Math.max(...leaderboardLatency, 0)} ms`)

  // End the room: frees the code and unlocks the deck for editing again.
  await post(`/api/sessions/${code}/end`, undefined, hostToken)
  clients.forEach((c) => c.removeAllChannels())
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
