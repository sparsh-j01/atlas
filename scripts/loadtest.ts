/**
 * M1 load test — the "prove 100+ concurrent" artifact.
 *
 * Spins up N simulated participants, each its own Supabase Realtime connection (so this
 * is a real concurrency test, not N channels on one socket). They join over HTTP, answer
 * the hardcoded question, then the host reveals and we measure how long the leaderboard
 * broadcast takes to fan out to every client.
 *
 * Prereqs: a running server (BASE_URL) and a live Supabase project (URL + anon key from
 * .env.local). Run:  npx tsx scripts/loadtest.ts [N]
 */
import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { sessionChannel } from '../lib/realtime/channels'
import { EVENTS } from '../lib/realtime/events'

config({ path: '.env.local' })

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000'
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const N = Number(process.argv[2] ?? process.env.LOADTEST_N ?? 120)

if (!SUPABASE_URL || !ANON) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local')
  process.exit(1)
}

const pctl = (xs: number[], p: number) => {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const rand = (max: number) => Math.floor(Math.random() * max)
const post = (path: string, body?: unknown) =>
  fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

async function main() {
  console.log(`Load test: ${N} clients → ${BASE_URL}`)

  const started = await post('/api/sessions/start').then((r) => r.json())
  const { code, hostToken, timeLimitMs } = started as { code: string; hostToken: string; timeLimitMs: number }
  console.log(`Session ${code} live.`)

  let joinOk = 0
  let answerOk = 0
  const leaderboardLatency: number[] = []
  const gotLeaderboard: Array<() => void> = []
  const clients: SupabaseClient[] = []

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
      const channel = supabase.channel(sessionChannel(code))
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

      // Answer at a human-ish random moment inside the window.
      await new Promise((r) => setTimeout(r, rand(Math.min(timeLimitMs - 2000, 6000))))
      const a = await post(`/api/sessions/${code}/answer`, {
        clientToken,
        optionId: ['a', 'b', 'c', 'd'][rand(4)],
      }).then((r) => r.json())
      if (a?.accepted) answerOk++
    }),
  )

  console.log(`Joined ${joinOk}/${N}, answers accepted ${answerOk}/${joinOk}. Revealing…`)

  const done = clients.map((_, i) => new Promise<void>((resolve) => (gotLeaderboard[i] = resolve)))
  revealSentAt = Date.now()
  await post(`/api/sessions/${code}/reveal`, { hostToken })

  // Wait for the fan-out (10s cap).
  await Promise.race([Promise.all(done), new Promise((r) => setTimeout(r, 10_000))])

  console.log('\n--- Results ---')
  console.log(`Join success:        ${joinOk}/${N} (${((100 * joinOk) / N).toFixed(1)}%)`)
  console.log(`Answers accepted:    ${answerOk}/${joinOk}`)
  console.log(`Leaderboard fan-out: ${leaderboardLatency.length}/${joinOk} clients received`)
  console.log(`  p50: ${pctl(leaderboardLatency, 50)} ms`)
  console.log(`  p95: ${pctl(leaderboardLatency, 95)} ms`)
  console.log(`  max: ${Math.max(...leaderboardLatency, 0)} ms`)

  clients.forEach((c) => c.removeAllChannels())
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
