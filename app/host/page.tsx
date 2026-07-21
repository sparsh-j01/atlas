'use client'

import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { avatarUrl } from '@/lib/avatars'
import { sessionChannel } from '@/lib/realtime/channels'
import { EVENTS } from '@/lib/realtime/events'
import type {
  AggregateMcq,
  LeaderboardEntry,
  SanitizedSlide,
  SlideRevealPayload,
} from '@/lib/realtime/events'

type Phase = 'idle' | 'live' | 'revealed'

export default function HostPage() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [session, setSession] = useState<{ code: string; hostToken: string } | null>(null)
  const [slide, setSlide] = useState<SanitizedSlide | null>(null)
  const [joined, setJoined] = useState(0)
  const [answered, setAnswered] = useState(0)
  const [correctId, setCorrectId] = useState<string | null>(null)
  const [aggregate, setAggregate] = useState<AggregateMcq | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [busy, setBusy] = useState(false)

  async function start() {
    setBusy(true)
    try {
      const res = await fetch('/api/sessions/start', { method: 'POST' })
      const data = await res.json()
      setSession({ code: data.code, hostToken: data.hostToken })
      setSlide(data.slide)
      setPhase('live')
    } finally {
      setBusy(false)
    }
  }

  async function reveal() {
    if (!session) return
    setBusy(true)
    try {
      await fetch(`/api/sessions/${session.code}/reveal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostToken: session.hostToken }),
      })
    } finally {
      setBusy(false)
    }
  }

  // Subscribe to the session channel once we have a code.
  useEffect(() => {
    if (!session) return
    const supabase = createClient()
    const channel = supabase.channel(sessionChannel(session.code))
    channel
      .on('broadcast', { event: EVENTS.ANSWERED_COUNT }, ({ payload }) => {
        setAnswered(payload.answered)
      })
      .on('broadcast', { event: EVENTS.SLIDE_REVEAL }, ({ payload }) => {
        const p = payload as SlideRevealPayload
        setCorrectId(p.correctOptionId ?? null)
        setAggregate(p.aggregate as AggregateMcq)
        setPhase('revealed')
      })
      .on('broadcast', { event: EVENTS.LEADERBOARD_UPDATE }, ({ payload }) => {
        setLeaderboard(payload.top as LeaderboardEntry[])
      })
      .on('presence', { event: 'sync' }, () => {
        setJoined(Object.keys(channel.presenceState()).length)
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [session])

  if (phase === 'idle') {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 p-8 text-center">
        <h1 className="text-3xl font-semibold">Host a live quiz</h1>
        <p className="text-neutral-500">M1 spike — one hardcoded question, end to end.</p>
        <button
          onClick={start}
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Starting…' : 'Start session'}
        </button>
      </main>
    )
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 p-8">
      <header className="flex items-center justify-between">
        <div>
          <div className="text-sm text-neutral-500">Join at /play with code</div>
          <div className="font-mono text-4xl font-bold tracking-widest">{session?.code}</div>
        </div>
        <div className="text-right text-sm text-neutral-500">
          <div>
            <span className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{joined}</span> joined
          </div>
          <div>
            <span className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">{answered}</span> answered
          </div>
        </div>
      </header>

      {slide && (
        <section className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
          <h2 className="mb-4 text-xl font-medium">{slide.prompt}</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {slide.options.map((o) => {
              const isCorrect = phase === 'revealed' && o.id === correctId
              const n = aggregate?.counts[o.id] ?? 0
              return (
                <li
                  key={o.id}
                  className={`flex items-center justify-between rounded-lg border px-4 py-3 ${
                    isCorrect
                      ? 'border-green-500 bg-green-50 dark:bg-green-950'
                      : 'border-neutral-200 dark:border-neutral-800'
                  }`}
                >
                  <span>{o.text}</span>
                  {phase === 'revealed' && <span className="text-sm text-neutral-500">{n}</span>}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {phase === 'live' && (
        <button
          onClick={reveal}
          disabled={busy}
          className="self-start rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Revealing…' : 'Reveal answer'}
        </button>
      )}

      {leaderboard.length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-medium">Leaderboard</h3>
          <ol className="flex flex-col gap-2">
            {leaderboard.map((e) => (
              <li
                key={e.participantId}
                className="flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-2 dark:border-neutral-800"
              >
                <span className="w-6 text-neutral-500">{e.rank}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={avatarUrl(e.avatarSeed)} alt="" className="h-8 w-8 rounded-full bg-neutral-100" />
                <span className="flex-1 font-medium">{e.nickname}</span>
                <span className="tabular-nums">{e.score}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  )
}
