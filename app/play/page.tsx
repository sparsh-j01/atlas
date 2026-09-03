'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { avatarUrl } from '@/lib/avatars'
import { Podium } from '@/components/Podium'
import { openSessionChannel } from '@/lib/realtime/channels'
import { isScored } from '@/lib/slides'
import { EVENTS } from '@/lib/realtime/events'
import { SiteHeader } from '@/components/SiteHeader'
import { btn, capCls, inputCls } from '@/components/ui'
import type {
  LeaderboardEntry,
  ParticipantKickedPayload,
  SanitizedSlide,
  SlideRevealPayload,
} from '@/lib/realtime/events'

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

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

// useSearchParams needs a Suspense boundary above it, so the room itself is a child.
export default function PlayPage() {
  return (
    <Suspense>
      <PlayRoom />
    </Suspense>
  )
}

function PlayRoom() {
  // The landing page hands the code over as ?code=, so the phone opens with it already typed.
  const linkedCode = useSearchParams().get('code')
  const [code, setCode] = useState(() => (linkedCode ?? '').replace(/\D/g, '').slice(0, 6))
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const [me, setMe] = useState<Joined | null>(null)
  const [status, setStatus] = useState<Status>('lobby')
  const [slide, setSlide] = useState<SanitizedSlide | null>(null)
  const [deadline, setDeadline] = useState<number | null>(null)
  // The full window. The drain bar needs the share remaining, which the deadline alone
  // cannot give it.
  const [windowMs, setWindowMs] = useState<number | null>(null)
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
      setWindowMs(timeLimitMs)
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
      setError('Could not join. Check your connection.')
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
            ? 'Too slow. The answer window closed.'
            : 'That did not go through. Try again.',
        )
        return
      }
      // Remember it against the slide, so a host who navigates back to this question
      // still sees this phone reporting the answer it actually gave.
      picksRef.current[slideId] = optionId
    } catch {
      pickedRef.current = null
      setPicked(null)
      setNotice('Network error. Try again.')
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
      // The header is a SIBLING of <main>, not inside it. SiteHeader's first child is the
      // skip link, and a skip link rendered inside the landmark it targets sends you
      // backwards past itself. The other three states below render no header, so <main> is
      // the whole screen and needs no id.
      <div className="flex min-h-screen flex-col">
        <SiteHeader />
        {/* Built for a phone, but it is a real URL someone opens on a laptop too, so the
            column is capped rather than stretched across a desktop viewport. */}
        <main
          id="main"
          className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 p-6"
        >
          <div>
            <h1 className="font-display text-3xl">Join the room</h1>
            <p className="mt-2 text-dim">The code is on the screen at the front.</p>
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="code" className={capCls}>
              Room code
            </label>
            <input
              id="code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              inputMode="numeric"
              autoComplete="off"
              placeholder="000000"
              className={`${inputCls} py-4 text-center tabular text-4xl tracking-[0.3em]`}
            />
          </div>

          <div className="flex flex-col gap-2">
            <label htmlFor="nickname" className={capCls}>
              Nickname
            </label>
            <input
              id="nickname"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              maxLength={24}
              placeholder="Pick anything"
              className={`${inputCls} py-4 text-xl`}
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-wrong">
              {error}
            </p>
          )}

          <button onClick={join} disabled={busy} className={`${btn('primary', 'xl')} w-full`}>
            {busy ? 'Joining' : 'Join'}
          </button>
        </main>
      </div>
    )
  }

  const myEntry = leaderboard.find((e) => e.participantId === me.participantId)

  if (status === 'ended') {
    return (
      <main className="stage flex min-h-screen flex-col justify-center gap-10 p-6">
        <div className="text-center">
          <h1 className="font-display text-3xl">That is a wrap</h1>
          {myEntry ? (
            <p className="mt-3 text-lg text-dim">
              You finished{' '}
              <span className="tabular text-ink">#{myEntry.rank}</span> with{' '}
              <span className="tabular text-ink">{myEntry.score}</span> points.
            </p>
          ) : (
            <p className="mt-3 text-dim">Thanks for playing.</p>
          )}
        </div>
        {/* The same podium the projector shows, with this player's own row picked out.
            session:ended carries the full ranking, so no extra fetch per phone. */}
        {leaderboard.length > 0 && <Podium ranking={leaderboard} highlightId={me.participantId} />}
      </main>
    )
  }

  // Lobby, or between slides after a reveal with nothing to show yet.
  if (!slide) {
    return (
      <main className="stage flex min-h-screen flex-col items-center justify-center gap-5 p-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={avatarUrl(me.avatarSeed)}
          alt=""
          className="h-24 w-24 rounded-full bg-overlay ring-2 ring-pen"
        />
        <h1 className="font-display text-3xl">{me.nickname}</h1>
        <p className="text-dim">You are in. Waiting for the host to start.</p>
      </main>
    )
  }

  const msLeft = status === 'active' && deadline ? Math.max(0, deadline - now) : null
  const secondsLeft = msLeft === null ? null : Math.ceil(msLeft / 1000)
  const fractionLeft = msLeft !== null && windowMs ? Math.min(1, msLeft / windowMs) : null
  // The tiles have to go dead when the clock does. Without this they stayed tappable with
  // the countdown reading 0, and a tap round-tripped to the server only to come back "Too
  // slow" — a control offering an action it can no longer perform (failure-patterns #49).
  // This is the phone's clock, which the countdown comment above already flags as
  // possibly skewed; a fast phone forfeits its last few hundred ms. That is the better
  // trade than a live-looking button that always loses.
  const windowClosed = msLeft !== null && msLeft <= 0
  const scored = isScored(slide.type)
  // Only a scored slide has a right answer to be judged against. Without the `scored` gate a
  // poll would compare the pick to a null correctId, fail, and tell every voter "Not this
  // time." for answering a question that had no wrong answer.
  const myResult =
    status === 'revealed' && picked && scored ? (picked === correctId ? 'correct' : 'wrong') : null

  return (
    <main className="stage flex min-h-screen flex-col">
      {/* The same drain the projector shows, so the phone and the room share one clock. */}
      <div className="h-1.5 w-full shrink-0 bg-rule" aria-hidden suppressHydrationWarning>
        {fractionLeft !== null && (
          <div
            // scaleX, not width: this transition re-fires every 200ms for the whole answer
            // window, and `width` is a layout property — on the host it reflows behind the
            // question, on 100 phones it does it 100 times. A transform is compositor-only.
            // The bar is a square-edged rectangle, so there is no radius to distort.
            //
            // Always --pen. It used to flip to --wrong under 5s, which spent the coral that
            // means "your answer was wrong" five seconds before the reveal used it for
            // exactly that, on this same screen. docs/design.md §3 reserves correct/wrong
            // for graded answers and §8 specifies the drain in --pen. The length of the bar
            // and the number beside it already carry the urgency; the colour was a third
            // encoding of the same fact, and the one that collided.
            className="h-full w-full origin-left bg-pen transition-transform duration-200 ease-linear"
            style={{ transform: `scaleX(${fractionLeft})` }}
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-6 p-5">
        {/* flex-1: the question takes the slack the tiles gave up and sits centred in it,
            rather than pinned to the top with a dead band underneath. */}
        <div className="flex flex-1 items-center justify-between gap-4">
          <h1 className="text-xl font-semibold leading-snug">{slide.prompt}</h1>
          {/* --pen at every count, for the same reason as the drain bar above. */}
          {secondsLeft !== null && (
            <span
              aria-live="off"
              suppressHydrationWarning
              className="shrink-0 tabular text-3xl tabular-nums text-pen"
            >
              {secondsLeft}
            </span>
          )}
        </div>

        {/* Bottom-anchored: this block never grows, so the flex-1 question row above takes
            every spare pixel and the tiles settle at the foot of the viewport. On a 390×844
            phone the stack ran 105px→421px — ending at exactly half the screen, with option
            A in the hardest place to reach one-handed and the easy-reach half empty. It now
            ends at 824. The lock-in and rejection messages sit inside this block, so a
            closed window is answered beside the tile that was tapped rather than at the
            foot of the page. */}
        <div className="flex shrink-0 flex-col gap-3">
          <div className="grid gap-3">
            {slide.options.map((o, i) => {
              const isPicked = picked === o.id
              const isCorrect = status === 'revealed' && o.id === correctId
              const live = status === 'active' && !picked && !windowClosed
              // After the reveal, everything that is neither the key nor your own pick fades
              // back so the two answers that matter are the two you can read.
              const muted = status === 'revealed' && !isCorrect && !isPicked
              return (
                <button
                  key={o.id}
                  onClick={() => answer(o.id)}
                  disabled={status !== 'active' || picked !== null || windowClosed}
                  style={{ touchAction: 'manipulation' }}
                  className={`flex items-center gap-4 rounded-plate border px-4 py-4 text-left transition-[transform,background-color,border-color,opacity] duration-150 ease-out ${
                    live ? 'active:scale-[0.97]' : ''
                  } ${
                    isCorrect
                      ? 'border-correct bg-correct/15'
                      : isPicked
                        ? status === 'revealed' && scored
                          ? 'border-wrong bg-wrong/15'
                          : 'border-pen bg-pen/15'
                        : 'border-rule bg-raised'
                  } ${live ? 'active:border-pen active:bg-overlay' : 'cursor-default'}`}
                >
                  <span
                    aria-hidden
                    className={`grid h-9 w-9 shrink-0 place-items-center rounded-pill tabular ${
                      isCorrect
                        ? 'bg-correct text-pen-on'
                        : isPicked
                          ? status === 'revealed' && scored
                            ? 'bg-wrong text-pen-on'
                            : 'bg-pen text-pen-on'
                          : 'bg-overlay text-dim'
                    }`}
                  >
                    {LETTERS[i] ?? i + 1}
                  </span>
                  {/* The muted state dims the TEXT, not the tile. Opacity on the button dropped
                      the letter badge to 2.4:1, and the letter is how a student matches their
                      phone to the projector — it is the last thing that may fade. */}
                  <span className={`text-lg leading-snug ${muted ? 'opacity-60' : ''}`}>{o.text}</span>
                </button>
              )
            })}
          </div>

          {status === 'active' && picked && (
            <p className="text-center text-dim">
              {scored ? 'Answer locked in. Hang tight.' : 'Vote locked in. Watch the screen.'}
            </p>
          )}
          {/* Says why the tiles went dead, in the place they went dead. */}
          {status === 'active' && !picked && windowClosed && (
            <p role="status" className="text-center text-sm text-dim">
              {scored ? 'Time. Answers are closed.' : 'Time. Voting is closed.'}
            </p>
          )}
          {notice && (
            <p role="alert" className="anim-fade-up text-center text-sm text-wrong">
              {notice}
            </p>
          )}
        </div>

        {status === 'revealed' && (
          <div className="flex flex-col gap-4">
            <p
              className={`text-center text-2xl font-bold ${
                myResult === 'correct'
                  ? 'text-correct'
                  : myResult === 'wrong'
                    ? 'text-wrong'
                    : 'text-dim'
              }`}
            >
              {scored
                ? myResult === 'correct'
                  ? 'Correct'
                  : myResult === 'wrong'
                    ? 'Not this time'
                    : 'No answer in'
                : picked
                  ? 'Vote counted'
                  : 'No vote in'}
            </p>
            {/* Rank shows for the broadcast top-N only. A personal score for everyone would
                mean 100 simultaneous /state fetches at every reveal. Withheld after a poll:
                nothing about the standings changed, so quoting a rank there implies the vote
                scored. */}
            {myEntry && scored && (
              <p className="text-center text-dim">
                <span className="tabular text-ink">#{myEntry.rank}</span> with{' '}
                <span className="tabular text-ink">{myEntry.score}</span>
              </p>
            )}
            {explanation && (
              <p className="rounded-plate border border-pen bg-pen-wash px-4 py-3 text-sm leading-relaxed text-dim">
                {explanation}
              </p>
            )}
          </div>
        )}
      </div>
    </main>
  )
}
