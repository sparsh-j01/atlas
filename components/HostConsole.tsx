'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { X } from '@phosphor-icons/react/ssr'
import { createClient } from '@/lib/supabase/client'
import { openHostChannel, openSessionChannel } from '@/lib/realtime/channels'
import { EVENTS } from '@/lib/realtime/events'
import type { ProgressState } from '@/lib/realtime/session-progress'
import { useSessionProgress } from '@/lib/realtime/use-session-progress'
import { DeleteButton } from '@/components/DeleteButton'
import { Leaderboard } from '@/components/Leaderboard'
import { btn, capCls } from '@/components/ui'

export function HostConsole({ code, sessionId, joinHost, initialState }: {
  code: string
  sessionId: string
  joinHost: string
  initialState: ProgressState
}) {
  const [state, setState] = useState(initialState)
  const stateRef = useRef(initialState)
  const rankingVersion = useRef(-1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  const applyState = useCallback((next: ProgressState) => {
    const current = stateRef.current
    if (current.status === 'ended' && next.status !== 'ended') return
    if (next.serverStartedAt && current.serverStartedAt && Date.parse(next.serverStartedAt) < Date.parse(current.serverStartedAt)) return
    stateRef.current = next
    setState(next)
    setError('')
  }, [])

  const sync = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${code}/progress`, { cache: 'no-store' })
      if (!res.ok) return
      applyState(await res.json())
    } catch { /* The deadline wake-up retries a lost connection. */ }
  }, [code, applyState])

  useSessionProgress({ code, status: state.status, index: state.index,
    serverStartedAt: state.serverStartedAt, timeLimitMs: state.timeLimitMs,
    onProgress: applyState, onError: setError })

  useEffect(() => {
    const supabase = createClient()
    let syncTimer: ReturnType<typeof setTimeout> | undefined
    const room = openSessionChannel(supabase, code)
    const host = openHostChannel(supabase, code)
    const updateRanking = (payload: { top: ProgressState['leaderboard']; completedIndex?: number }) => {
      const version = payload.completedIndex ?? stateRef.current.index
      if (version < rankingVersion.current) return
      rankingVersion.current = version
      applyState({ ...stateRef.current, leaderboard: payload.top })
    }
    host.on('broadcast', { event: EVENTS.LEADERBOARD_UPDATE }, ({ payload }) => updateRanking(payload)).subscribe()
    room
      .on('broadcast', { event: EVENTS.SLIDE_SHOW }, ({ payload }) => {
        applyState({ ...stateRef.current, status: payload.status, index: payload.index,
          slide: payload.slide, serverStartedAt: payload.serverStartedAt, timeLimitMs: payload.timeLimitMs })
      })
      .on('broadcast', { event: EVENTS.SESSION_ENDED }, ({ payload }) => {
        applyState({ ...stateRef.current, status: 'ended', slide: null, leaderboard: payload.fullRanking })
      })
      // A class arriving fires one sync per join; refetch once it settles, not 100 times.
      .on('presence', { event: 'sync' }, () => {
        clearTimeout(syncTimer)
        syncTimer = setTimeout(() => void sync(), 750)
      })
      .subscribe()
    const resume = () => { if (document.visibilityState === 'visible') void sync() }
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      clearTimeout(syncTimer)
      void supabase.removeChannel(room)
      void supabase.removeChannel(host)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [code, applyState, sync])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])

  async function call(path: string, body?: unknown) {
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`/api/sessions/${code}/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) throw new Error(data?.error ?? 'That did not go through. Try again.')
      return data
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error. Try again.')
      return null
    } finally { setBusy(false) }
  }

  async function start() {
    const data = await call('advance', { index: 0 })
    if (data) applyState({ ...stateRef.current, ...data })
  }

  async function end() {
    const data = await call('end')
    if (!data) throw new Error('Could not end the session. Try again.')
    applyState({ ...stateRef.current, status: 'ended', slide: null, leaderboard: data.fullRanking })
  }

  async function kick(participantId: string) {
    if (await call('kick', { participantId })) {
      applyState({ ...stateRef.current, leaderboard: stateRef.current.leaderboard.filter((p) => p.participantId !== participantId) })
    }
  }

  const lobby = state.status === 'lobby'
  const ended = state.status === 'ended'
  const deadline = state.status === 'active' && state.serverStartedAt && state.timeLimitMs
    ? Date.parse(state.serverStartedAt) + state.timeLimitMs : null

  return (
    <main id="main" className="stage flex min-h-svh flex-col">
      <RoomTimer key={deadline ?? 'idle'} deadline={deadline} windowMs={state.timeLimitMs} />
      <header className="flex flex-wrap items-end justify-between gap-5 border-b border-rule px-6 py-6 sm:px-10">
        <div>
          <p className={capCls}>Join at {joinHost}/play</p>
          <div className="mt-2 flex items-center gap-4">
            <h1 className="tabular text-4xl tracking-[0.12em] text-pen sm:text-5xl">{code}</h1>
            <button type="button" className={btn('secondary', 'sm')} onClick={() => {
              navigator.clipboard?.writeText(code).then(() => setCopied(true), () => setError('Could not copy the code.'))
            }}>{copied ? 'Copied' : 'Copy'}</button>
            <span className="sr-only" aria-live="polite">{copied ? 'Room code copied' : ''}</span>
          </div>
        </div>
        <div className="text-right">
          <p className="text-lg font-semibold">{state.leaderboard.length} participants</p>
          <p className="mt-1 text-sm text-dim">{lobby ? 'Waiting to start' : ended ? 'Quiz complete' : `Question ${state.index + 1} of ${state.total} · advances automatically`}</p>
        </div>
      </header>

      <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 px-5 py-8 sm:px-10">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-3xl sm:text-5xl">{lobby ? 'Your classroom' : ended ? 'Final leaderboard' : 'Leaderboard'}</h2>
          {!lobby && <span className={capCls}>Rank · name · score</span>}
        </div>
        {lobby ? (
          <>
            <p className="text-dim">Students join with the code above. Start once your class is ready.</p>
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {state.leaderboard.map((p) => (
                <li key={p.participantId} className="flex items-center justify-between gap-3 rounded-plate border border-rule bg-raised p-4">
                  <span className="min-w-0 break-words text-lg font-semibold">{p.nickname}</span>
                  <button type="button" onClick={() => kick(p.participantId)} disabled={busy}
                    aria-label={`Remove ${p.nickname}`} className="grid size-11 shrink-0 place-items-center rounded-full text-dim hover:bg-wrong-wash hover:text-wrong">
                    <X size={16} />
                  </button>
                </li>
              ))}
            </ul>
            {state.leaderboard.length === 0 && <p className="py-12 text-center text-dim">Waiting for students to join…</p>}
          </>
        ) : state.leaderboard.length > 0 ? (
          <Leaderboard entries={state.leaderboard} />
        ) : <p className="py-12 text-center text-dim">No participants joined.</p>}
        {ended && (
          <div className="flex flex-wrap gap-3 pt-4">
            <Link href={`/results/${sessionId}`} className={btn('pen', 'lg')}>View improvement report</Link>
            <Link href="/dashboard" className={btn('secondary', 'lg')}>Back to your decks</Link>
          </div>
        )}
      </section>

      {!ended && <footer className="sticky bottom-0 border-t border-rule bg-ground/95 px-6 py-4 backdrop-blur sm:px-10">
        {error && <p role="alert" className="mb-3 text-sm text-wrong">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-4">
          {lobby ? <button type="button" onClick={start} disabled={busy || state.total === 0} className={btn('pen', 'lg')}>
            {busy ? 'Starting…' : 'Start the session'}
          </button> : <p className="text-sm text-dim">Scores update after every question. Students review their answers at the end.</p>}
          <DeleteButton action={end} confirmText="End this session for everyone?" label="End session" pendingLabel="Ending" className={btn('danger', 'md')} />
        </div>
      </footer>}
    </main>
  )
}

function RoomTimer({ deadline, windowMs }: { deadline: number | null; windowMs: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!deadline) return
    const timer = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(timer)
  }, [deadline])
  const fraction = deadline && windowMs ? Math.max(0, Math.min(1, (deadline - now) / windowMs)) : 0
  return <div className="h-1.5 bg-rule" aria-hidden suppressHydrationWarning>
    <div className="h-full w-full origin-left bg-pen transition-transform duration-200 ease-linear" style={{ transform: `scaleX(${fraction})` }} />
  </div>
}
