'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { avatarUrl } from '@/lib/avatars'
import { Podium } from '@/components/Podium'
import { openSessionChannel } from '@/lib/realtime/channels'
import { isScored } from '@/lib/slides'
import { EVENTS } from '@/lib/realtime/events'
import type {
  LeaderboardEntry,
  ParticipantKickedPayload,
  SanitizedSlide,
  SlideRevealPayload,
} from '@/lib/realtime/events'

type Status = 'lobby' | 'active' | 'revealed' | 'ended'
type Joined = {
  code: string
  clientToken: string
  participantId: string
  nickname: string
  avatarSeed: string
}

// One entry, not one per code: a phone is in at most one room at a time, and this is what
// the reconnect on mount reads. Cleared when the session is gone or over.
const STORE_KEY = 'quiz:session'

export default function PlayPage() {
  const [code, setCode] = useState('')
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [me, setMe] = useState<Joined | null>(null)
  const [status, setStatus] = useState<Status>('lobby')
  const [slide, setSlide] = useState<SanitizedSlide | null>(null)
  const [deadline, setDeadline] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [picked, setPicked] = useState<string | null>(null)
  const pickedRef = useRef<string | null>(null)
  // This phone's own answer per slide. The host can navigate back to a slide we already
  // answered, and a broadcast can't carry the pick (one payload, every participant), so
  // without this a player who answered would be told "No answer in". Read inside the
  // broadcast handler, which closes over stale state — hence a ref, not state.
  const picksRef = useRef<Record<string, string>>({})
  const [correctId, setCorrectId] = useState<string | null>(null)
  const [explanation, setExplanation] = useState<string | null>(null)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  const [notice, setNotice] = useState('')

  // The server's start stamp for the slide currently on screen. Two `advance` calls in quick
  // succession are two separate serverless invocations publishing independently, so their
  // slide:show messages can reach a phone out of order and leave it on the slide the room
  // already left. This is the ordering key: it's set by the server on every advance, it only
  // moves forward, and it's already in the payload — so no sequence counter has to be
  // invented, stored, or migrated. A ref, not state, because the broadcast handler subscribes
  // once and would otherwise close over the value at mount (failure-patterns #11).
  const startedAtRef = useRef<number>(0)
  // Which slide this phone is on, for the slide-addressed events (reveal). Same role the
  // console's slideIdRef plays; written in the same tick as the slide itself.
  const slideIdRef = useRef<string | null>(null)

  // Every path onto a slide (join, reconnect, slide:show) lands here, so a new slide can't
  // leave a stale pick or a stale reveal behind.
  const showSlide = useCallback(
    (
      s: SanitizedSlide | null,
      serverStartedAt: string | null,
      timeLimitMs: number | null,
      alreadyPicked: string | null = null,
    ) => {
      startedAtRef.current = serverStartedAt ? Date.parse(serverStartedAt) : 0
      slideIdRef.current = s?.id ?? null
      setSlide(s)
      // ponytail: the countdown compares the server's start stamp against the phone's clock,
      // so a badly-skewed device sees a wrong number. It's cosmetic — the server rejects late
      // answers by its own clock. Upgrade path if it ever matters: a clock-offset handshake.
      setDeadline(serverStartedAt && timeLimitMs ? Date.parse(serverStartedAt) + timeLimitMs : null)
      setNow(Date.now()) // seed the countdown here, so the first frame isn't a tick stale
      if (s && alreadyPicked) picksRef.current[s.id] = alreadyPicked
      pickedRef.current = alreadyPicked
      setPicked(alreadyPicked)
      setCorrectId(null)
      setExplanation(null) // cleared with the answer key; both only return at reveal
      setNotice('')
    },
    [],
  )

  async function join() {
    setError('')
    const nick = nickname.trim()
    const joinCode = code.trim()
    if (!joinCode || !nick) {
      setError('Enter a code and a nickname.')
      return
    }
    setBusy(true)
    try {
      const res = await fetch(`/api/sessions/${joinCode}/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nickname: nick }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok) {
        setError(data?.error ?? 'Could not join.')
        return
      }
      const joined: Joined = {
        code: joinCode,
        clientToken: data.clientToken,
        participantId: data.participantId,
        // The server's sanitized nickname, not the raw input — this one goes on the projector.
        nickname: data.nickname ?? nick,
        avatarSeed: data.avatarSeed,
      }
      // Server-issued token, stored so a reload or a dropped connection rejoins the same seat.
      localStorage.setItem(STORE_KEY, JSON.stringify(joined))
      setStatus(data.status)
      showSlide(data.slide, data.serverStartedAt, data.timeLimitMs)
      setMe(joined)
    } catch {
      setError('Could not join — check your connection.')
    } finally {
      setBusy(false)
    }
  }

  async function answer(optionId: string) {
    if (!me || !slide || pickedRef.current || status !== 'active') return
    const slideId = slide.id
    pickedRef.current = optionId
    setPicked(optionId)
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
        setNotice(
          data?.reason === 'late'
            ? 'Too slow — the answer window closed.'
            : 'That didn’t go through — try again.',
        )
        return
      }
      // Remember it against the slide, so a host who navigates back to this question
      // still sees this phone reporting the answer it actually gave.
      picksRef.current[slideId] = optionId
    } catch {
      pickedRef.current = null
      setPicked(null)
      setNotice('Network error — try again.')
    }
  }

  // Reconnect on mount: Broadcast is ephemeral, so the saved token buys back the live slide,
  // this phone's own pick, and its score from /state.
  useEffect(() => {
    const raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    let saved: Joined
    try {
      saved = JSON.parse(raw)
    } catch {
      localStorage.removeItem(STORE_KEY)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(`/api/sessions/${saved.code}/state`, {
          headers: { Authorization: `Bearer ${saved.clientToken}` },
        })
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || data?.status === 'ended') {
          localStorage.removeItem(STORE_KEY)
          return
        }
        setStatus(data.status)
        showSlide(data.slide, data.serverStartedAt, data.timeLimitMs, data.myOptionId ?? null)
        setCorrectId(data.correctOptionId ?? null)
        setExplanation(data.explanation ?? null)
        setMe(saved)
      } catch {
        // Offline on load — stay on the join form rather than pretending to be in a room.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showSlide])

  // Subscribe + announce presence once joined. Presence is what fills the host's lobby roster.
  useEffect(() => {
    if (!me) return
    const supabase = createClient()
    const channel = openSessionChannel(supabase, me.code)
    channel
      .on('broadcast', { event: EVENTS.SLIDE_SHOW }, ({ payload }) => {
        const next = payload.slide as SanitizedSlide
        // Drop a slide:show older than the one on screen. Ordering between two independent
        // publishes isn't guaranteed, and applying the stale one strands this phone on a
        // slide the room has left — it would sit there until the next broadcast, unable to
        // answer, since the server scores against ITS current slide. Not `!==`: re-showing
        // the same slide is legitimate (Back), and it always carries a newer stamp.
        const startedAt = Date.parse(payload.serverStartedAt)
        if (startedAt < startedAtRef.current) return
        // Trust the server's status: a re-shown slide arrives already 'revealed', so the
        // options never flash as tappable before the slide:reveal lands.
        setStatus(payload.status === 'revealed' ? 'revealed' : 'active')
        // Restore this phone's answer if it already has one for the slide being shown.
        showSlide(next, payload.serverStartedAt, payload.timeLimitMs, picksRef.current[next.id] ?? null)
      })
      .on('broadcast', { event: EVENTS.SLIDE_REVEAL }, ({ payload }) => {
        const p = payload as SlideRevealPayload
        // The console's copy of this handler was the one flagged in review, but the phone
        // runs the same shape and the consequence here is worse: a reveal for the outgoing
        // slide would grey out the options and print "Not this time" on a question this
        // player is still answering, comparing their pick to the previous slide's key.
        if (slideIdRef.current && p.slideId !== slideIdRef.current) return
        setCorrectId(p.correctOptionId ?? null)
        setExplanation(p.explanation ?? null)
        setStatus('revealed')
      })
      .on('broadcast', { event: EVENTS.LEADERBOARD_UPDATE }, ({ payload }) => {
        setLeaderboard(payload.top as LeaderboardEntry[])
      })
      .on('broadcast', { event: EVENTS.SESSION_ENDED }, ({ payload }) => {
        setLeaderboard(payload.fullRanking as LeaderboardEntry[])
        setStatus('ended')
        localStorage.removeItem(STORE_KEY)
      })
      // Broadcast has no per-client addressing, so the whole room hears this and only the
      // phone it names acts. Back to the join form rather than a dead-end screen: rejoining
      // under a different name is allowed (there's no identity to ban), and a stuck screen
      // would just get a page reload anyway.
      .on('broadcast', { event: EVENTS.PARTICIPANT_KICKED }, ({ payload }) => {
        if ((payload as ParticipantKickedPayload).participantId !== me.participantId) return
        localStorage.removeItem(STORE_KEY)
        // Drop the answer history with the seat. This page returns to the join form without
        // unmounting, so the refs survive — and rejoining the SAME room means the same slide
        // uuids, which slide:show would use to restore the removed participant's pick and
        // leave the new one unable to answer.
        picksRef.current = {}
        pickedRef.current = null
        setPicked(null)
        setMe(null)
        setSlide(null)
        setStatus('lobby')
        setError('The host removed you from this session.')
      })
      .subscribe((s) => {
        if (s === 'SUBSCRIBED') {
          channel.track({
            participantId: me.participantId,
            nickname: me.nickname,
            avatarSeed: me.avatarSeed,
          })
        }
      })
    return () => {
      supabase.removeChannel(channel)
    }
  }, [me, showSlide])

  // Tick only while a slide is live; the countdown is the only thing that needs `now`.
  useEffect(() => {
    if (status !== 'active' || !deadline) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [status, deadline])

  if (!me) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-4 p-8">
        <h1 className="text-2xl font-semibold">Join the quiz</h1>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          inputMode="numeric"
          placeholder="6-digit code"
          aria-label="Session code"
          className="rounded-lg border border-neutral-300 px-4 py-3 font-mono text-lg tracking-widest dark:border-neutral-700 dark:bg-neutral-900"
        />
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          maxLength={24}
          placeholder="Nickname"
          aria-label="Nickname"
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

  const myEntry = leaderboard.find((e) => e.participantId === me.participantId)

  if (status === 'ended') {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 p-6">
        <div className="text-center">
          <h1 className="text-2xl font-semibold">That’s a wrap</h1>
          {myEntry ? (
            <p className="mt-2 text-lg">
              You finished <span className="font-semibold">#{myEntry.rank}</span> with{' '}
              <span className="font-semibold tabular-nums">{myEntry.score}</span> points.
            </p>
          ) : (
            <p className="mt-2 text-neutral-500">Thanks for playing.</p>
          )}
        </div>
        {/* The same podium the projector shows, with this player's own row picked out —
            session:ended carries the full ranking, so no extra fetch per phone. */}
        {leaderboard.length > 0 && (
          <Podium ranking={leaderboard} highlightId={me.participantId} />
        )}
      </main>
    )
  }

  // Lobby, or between slides after a reveal with nothing to show yet.
  if (!slide) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl(me.avatarSeed)}
          alt=""
          className="h-20 w-20 rounded-full bg-neutral-100"
        />
        <h1 className="text-2xl font-semibold">{me.nickname}</h1>
        <p className="text-neutral-500">You’re in. Waiting for the host to start…</p>
      </main>
    )
  }

  const secondsLeft =
    status === 'active' && deadline ? Math.max(0, Math.ceil((deadline - now) / 1000)) : null
  const scored = isScored(slide.type)
  // Only a scored slide has a right answer to be judged against. Without the `scored` gate a
  // poll would compare the pick to a null correctId, fail, and tell every voter "Not this
  // time." for answering a question that had no wrong answer.
  const myResult =
    status === 'revealed' && picked && scored ? (picked === correctId ? 'correct' : 'wrong') : null

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-6 p-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-xl font-medium">{slide.prompt}</h1>
        {secondsLeft !== null && (
          <span
            aria-live="off"
            className={`shrink-0 font-mono text-2xl tabular-nums ${
              secondsLeft <= 5 ? 'text-red-600' : 'text-neutral-500'
            }`}
          >
            {secondsLeft}
          </span>
        )}
      </div>

      <div className="grid gap-3">
        {slide.options.map((o) => {
          const isPicked = picked === o.id
          const isCorrect = status === 'revealed' && o.id === correctId
          return (
            <button
              key={o.id}
              onClick={() => answer(o.id)}
              disabled={status !== 'active' || picked !== null}
              className={`rounded-lg border px-4 py-4 text-left text-lg transition ${
                isCorrect
                  ? 'border-green-500 bg-green-50 dark:bg-green-950'
                  : isPicked
                    ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950'
                    : 'border-neutral-300 dark:border-neutral-700'
              } ${status === 'active' && !picked ? 'hover:border-indigo-400' : 'cursor-default'}`}
            >
              {o.text}
            </button>
          )
        })}
      </div>

      {status === 'active' && picked && (
        <p className="text-center text-neutral-500">
          {scored ? 'Answer locked in — hang tight.' : 'Vote locked in — watch the screen.'}
        </p>
      )}
      {notice && <p className="text-center text-sm text-red-600">{notice}</p>}
      {status === 'revealed' && explanation && (
        <p className="rounded-lg bg-neutral-100 px-4 py-3 text-sm leading-relaxed dark:bg-neutral-800">
          {explanation}
        </p>
      )}
      {status === 'revealed' && (
        <p
          className={`text-center text-lg font-semibold ${
            myResult === 'correct'
              ? 'text-green-600'
              : myResult === 'wrong'
                ? 'text-red-600'
                : 'text-neutral-500'
          }`}
        >
          {scored
            ? myResult === 'correct'
              ? 'Correct!'
              : myResult === 'wrong'
                ? 'Not this time.'
                : 'No answer in.'
            : picked
              ? 'Vote counted — results are on the screen.'
              : 'No vote in.'}
          {/* Rank shows for the broadcast top-N only — a personal score for everyone would mean
              100 simultaneous /state fetches at every reveal. Full per-player scoring is M4.
              Withheld after a poll: nothing about the standings changed, so quoting a rank
              there implies the vote scored. */}
          {myEntry && scored && ` You’re #${myEntry.rank} with ${myEntry.score}.`}
        </p>
      )}
    </main>
  )
}
