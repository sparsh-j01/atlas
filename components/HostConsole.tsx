'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { avatarUrl } from '@/lib/avatars'
import { openSessionChannel } from '@/lib/realtime/channels'
import { EVENTS } from '@/lib/realtime/events'
import type {
  AggregateMcq,
  LeaderboardEntry,
  PresenceState,
  SanitizedSlide,
} from '@/lib/realtime/events'
import { DeleteButton } from '@/components/DeleteButton'

type Status = 'lobby' | 'active' | 'revealed' | 'ended'

// The host's live console: lobby roster, slide navigation, reveal, end. Every control is a
// POST to a host-only route; the httpOnly host-token cookie authorizes it, so this component
// never holds the token. Server responses drive state directly rather than waiting on the
// session's own broadcast — best-effort Realtime shouldn't be able to strand the host.
export function HostConsole({
  code,
  total,
  initialIndex,
  initialStatus,
  initialSlide,
  initialCorrectId,
}: {
  code: string
  total: number
  initialIndex: number
  initialStatus: string
  initialSlide: SanitizedSlide | null
  initialCorrectId: string | null
}) {
  const [status, setStatus] = useState<Status>(initialStatus as Status)
  const [index, setIndex] = useState(initialIndex)
  const [slide, setSlide] = useState<SanitizedSlide | null>(initialSlide)
  const [roster, setRoster] = useState<PresenceState[]>([])
  const [answered, setAnswered] = useState(0)
  const [correctId, setCorrectId] = useState<string | null>(initialCorrectId)
  const [aggregate, setAggregate] = useState<AggregateMcq | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const call = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true)
      setError('')
      try {
        const res = await fetch(`/api/sessions/${code}/${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) {
          setError(data?.error ?? 'That didn’t go through — try again.')
          return null
        }
        return data
      } catch {
        setError('Network error — try again.')
        return null
      } finally {
        setBusy(false)
      }
    },
    [code],
  )

  async function goTo(target: number) {
    const data = await call('advance', { index: target })
    if (!data) return
    setIndex(data.index)
    setSlide(data.slide)
    setStatus('active')
    setAnswered(0)
    setCorrectId(null)
    setAggregate(null)
  }

  async function reveal() {
    const data = await call('reveal')
    if (!data) return
    setStatus('revealed')
    setCorrectId(data.correctOptionId ?? null)
    setAggregate(data.aggregate)
    setLeaderboard(data.top)
  }

  async function end() {
    const data = await call('end')
    if (!data) throw new Error('end failed') // DeleteButton surfaces the retry hint
    setStatus('ended')
    setLeaderboard(data.fullRanking)
  }

  // One subscription for the whole session: presence drives the lobby roster, the throttled
  // answered-count drives the live progress readout.
  useEffect(() => {
    const supabase = createClient()
    const channel = openSessionChannel(supabase, code)
    channel
      .on('broadcast', { event: EVENTS.ANSWERED_COUNT }, ({ payload }) => {
        setAnswered(payload.answered)
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<PresenceState>()
        setRoster(Object.values(state).flatMap((entries) => entries.slice(0, 1)))
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [code])

  const atLast = index >= total - 1

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex items-start justify-between gap-6">
        <div>
          <div className="text-sm text-neutral-500">Players join at /play with code</div>
          <div className="font-mono text-5xl font-bold tracking-widest">{code}</div>
        </div>
        <div className="text-right text-sm text-neutral-500">
          <div>
            <span className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
              {roster.length}
            </span>{' '}
            in the room
          </div>
          {status !== 'lobby' && (
            <>
              <div>
                <span className="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">
                  {answered}
                </span>{' '}
                answered
              </div>
              <div>
                Slide {index + 1} of {total}
              </div>
            </>
          )}
        </div>
      </header>

      {status === 'lobby' && (
        <section className="flex flex-col gap-4">
          <h2 className="text-lg font-medium">Lobby</h2>
          {roster.length === 0 ? (
            <p className="text-neutral-500">Waiting for players to join…</p>
          ) : (
            <ul className="flex flex-wrap gap-3">
              {roster.map((p) => (
                <li
                  key={p.participantId}
                  className="flex items-center gap-2 rounded-full border border-neutral-200 py-1 pl-1 pr-3 dark:border-neutral-800"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={avatarUrl(p.avatarSeed)}
                    alt=""
                    className="h-8 w-8 rounded-full bg-neutral-100"
                  />
                  <span className="text-sm font-medium">{p.nickname}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {slide && status !== 'ended' && (
        <section className="rounded-xl border border-neutral-200 p-6 dark:border-neutral-800">
          <h2 className="mb-4 text-xl font-medium">{slide.prompt}</h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {slide.options.map((o) => {
              const isCorrect = status === 'revealed' && o.id === correctId
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
                  {/* Only when we actually hold a tally — after a reload mid-reveal there
                      is none, and showing 0 everywhere would misreport the room. */}
                  {status === 'revealed' && aggregate && (
                    <span className="text-sm text-neutral-500">{aggregate.counts[o.id] ?? 0}</span>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {status === 'ended' ? (
        <p className="text-neutral-500">Session ended. The code is free for reuse.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          {status === 'lobby' ? (
            <button
              onClick={() => goTo(0)}
              disabled={busy || total === 0}
              className="rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white disabled:opacity-50"
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
          ) : (
            <>
              <button
                onClick={() => goTo(index - 1)}
                disabled={busy || index <= 0}
                className="rounded-lg border border-neutral-300 px-4 py-3 font-medium disabled:opacity-40 dark:border-neutral-700"
              >
                Back
              </button>
              {status === 'active' && (
                <button
                  onClick={reveal}
                  disabled={busy}
                  className="rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white disabled:opacity-50"
                >
                  Reveal
                </button>
              )}
              <button
                onClick={() => goTo(index + 1)}
                disabled={busy || atLast}
                className="rounded-lg border border-neutral-300 px-4 py-3 font-medium disabled:opacity-40 dark:border-neutral-700"
              >
                {status === 'active' ? 'Skip' : 'Next'}
              </button>
            </>
          )}
          <DeleteButton
            action={end}
            confirmText="End this session for everyone?"
            label="End session"
            pendingLabel="Ending…"
            className="text-sm text-red-600 hover:underline"
          />
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {leaderboard.length > 0 && (
        <section>
          <h3 className="mb-3 text-lg font-medium">
            {status === 'ended' ? 'Final ranking' : 'Leaderboard'}
          </h3>
          <ol className="flex flex-col gap-2">
            {leaderboard.map((e) => (
              <li
                key={e.participantId}
                className="flex items-center gap-3 rounded-lg border border-neutral-200 px-4 py-2 dark:border-neutral-800"
              >
                <span className="w-6 text-neutral-500">{e.rank}</span>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={avatarUrl(e.avatarSeed)}
                  alt=""
                  className="h-8 w-8 rounded-full bg-neutral-100"
                />
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
