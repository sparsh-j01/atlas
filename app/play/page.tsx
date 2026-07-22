'use client'

import { useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { sessionChannel } from '@/lib/realtime/channels'
import { EVENTS } from '@/lib/realtime/events'
import type { LeaderboardEntry, SanitizedSlide, SlideRevealPayload } from '@/lib/realtime/events'

type Phase = 'join' | 'playing' | 'answered' | 'revealed'
type Joined = { code: string; clientToken: string; participantId: string; nickname: string; avatarSeed: string }

export default function PlayPage() {
  const [code, setCode] = useState('')
  const [nickname, setNickname] = useState('')
  const [phase, setPhase] = useState<Phase>('join')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [me, setMe] = useState<Joined | null>(null)
  const [slide, setSlide] = useState<SanitizedSlide | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const pickedRef = useRef<string | null>(null)
  const [correctId, setCorrectId] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [notice, setNotice] = useState('')

  async function join() {
    setError('')
    const nick = nickname.trim()
    if (!code.trim() || !nick) {
      setError('Enter a code and a nickname.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/sessions/${code.trim()}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nick }),
      })
      if (!res.ok) {
        setError((await res.json().catch(() => ({})))?.error ?? 'Could not join.')
        return
      }
      const data = await res.json()
      const joined: Joined = {
        code: code.trim(),
        clientToken: data.clientToken,
        participantId: data.participantId,
        nickname: nick,
        avatarSeed: data.avatarSeed,
      }
      // Server-issued token, stored for reconnection (full auto-rejoin UI is M3).
      localStorage.setItem(`quiz:${joined.code}`, data.clientToken)
      setSlide(data.slide)
      setMe(joined)
      setPhase(data.slide ? 'playing' : 'join')
    } finally {
      setBusy(false)
    }
  }

  async function answer(optionId: string) {
    if (!me || pickedRef.current) return
    pickedRef.current = optionId
    setPicked(optionId)
    setPhase('answered')
    setNotice('')
    try {
      const res = await fetch(`/api/sessions/${me.code}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientToken: me.clientToken, optionId }),
      })
      const data = await res.json().catch(() => null)
      // A rejected submit (late / window closed / invalid) must not masquerade as a locked-in
      // answer — otherwise "Not this time" at reveal is indistinguishable from an honest miss.
      // Roll back the optimistic lock and say why.
      if (!res.ok || !data?.accepted) {
        pickedRef.current = null
        setPicked(null)
        setPhase('playing')
        setNotice(data?.reason === 'late' ? 'Too slow — the answer window closed.' : 'That didn’t go through — try again.')
      }
    } catch {
      pickedRef.current = null
      setPicked(null)
      setPhase('playing')
      setNotice('Network error — try again.')
    }
  }

  // Subscribe + announce presence once joined.
  useEffect(() => {
    if (!me) return
    const supabase = createClient()
    const channel = supabase.channel(sessionChannel(me.code))
    channel
      .on('broadcast', { event: EVENTS.SLIDE_SHOW }, ({ payload }) => {
        setSlide(payload.slide as SanitizedSlide)
        setPhase(pickedRef.current ? 'answered' : 'playing')
      })
      .on('broadcast', { event: EVENTS.SLIDE_REVEAL }, ({ payload }) => {
        setCorrectId((payload as SlideRevealPayload).correctOptionId ?? null)
        setPhase('revealed')
      })
      .on('broadcast', { event: EVENTS.LEADERBOARD_UPDATE }, ({ payload }) => {
        setLeaderboard(payload.top as LeaderboardEntry[])
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.track({ participantId: me.participantId, nickname: me.nickname, avatarSeed: me.avatarSeed })
        }
      })
    return () => {
      supabase.removeChannel(channel)
    }
  }, [me])

  if (phase === 'join') {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
        <h1 className="text-2xl font-semibold">Join the quiz</h1>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          placeholder="6-digit code"
          className="rounded-lg border border-neutral-300 px-4 py-3 font-mono text-lg tracking-widest dark:border-neutral-700 dark:bg-neutral-900"
        />
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={24}
          placeholder="Nickname"
          className="rounded-lg border border-neutral-300 px-4 py-3 dark:border-neutral-700 dark:bg-neutral-900"
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          onClick={join}
          disabled={busy}
          className="rounded-lg bg-indigo-600 px-6 py-3 font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Joining…' : 'Join'}
        </button>
      </main>
    )
  }

  const myResult = phase === 'revealed' && picked ? (picked === correctId ? 'correct' : 'wrong') : null
  const myEntry = leaderboard.find((e) => e.participantId === me?.participantId)

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      {slide && <h1 className="text-xl font-medium">{slide.prompt}</h1>}
      <div className="grid gap-3">
        {slide?.options.map((o) => {
          const isPicked = picked === o.id
          const isCorrect = phase === 'revealed' && o.id === correctId
          return (
            <button
              key={o.id}
              onClick={() => answer(o.id)}
              disabled={phase !== 'playing'}
              className={`rounded-lg border px-4 py-4 text-left text-lg transition ${
                isCorrect
                  ? 'border-green-500 bg-green-50 dark:bg-green-950'
                  : isPicked
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950'
                    : 'border-neutral-300 dark:border-neutral-700'
              } ${phase !== 'playing' ? 'cursor-default' : 'hover:border-indigo-400'}`}
            >
              {o.text}
            </button>
          )
        })}
      </div>

      {phase === 'answered' && <p className="text-center text-neutral-500">Answer locked in — hang tight.</p>}
      {notice && <p className="text-center text-sm text-red-600">{notice}</p>}
      {myResult && (
        <p className={`text-center text-lg font-semibold ${myResult === 'correct' ? 'text-green-600' : 'text-red-600'}`}>
          {myResult === 'correct' ? 'Correct!' : 'Not this time.'}
          {myEntry && ` You’re #${myEntry.rank} with ${myEntry.score}.`}
        </p>
      )}
    </main>
  )
}
