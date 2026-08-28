'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { X } from '@phosphor-icons/react/ssr'
import { createClient } from '@/lib/supabase/client'
import { avatarUrl } from '@/lib/avatars'
import { openHostChannel, openSessionChannel } from '@/lib/realtime/channels'
import { EVENTS } from '@/lib/realtime/events'
import type {
  AggregateMcq,
  LeaderboardEntry,
  PresenceState,
  ResultsUpdatePayload,
  SanitizedSlide,
  SlideRevealPayload,
} from '@/lib/realtime/events'
import { isScored } from '@/lib/slides'
import { DeleteButton } from '@/components/DeleteButton'
import { Leaderboard } from '@/components/Leaderboard'
import { Podium } from '@/components/Podium'
import { ProjectorSlide } from '@/components/ProjectorSlide'
import { ResultsChart } from '@/components/ResultsChart'
import { btn, capCls } from '@/components/ui'

type Status = 'lobby' | 'active' | 'revealed' | 'ended'

// The presenter view — this is the screen that goes on the projector, so everything is
// sized to be read from the back of a room. The host's controls live on the same page in a
// compact bar rather than a second route: a teacher's laptop is usually mirrored to the
// projector, and two windows would need cross-window sync for no gain. The participant's
// phone view is app/play.
//
// Every control is a POST to a host-only route; the httpOnly host-token cookie authorizes
// it, so this component never holds the token. Server responses drive state directly rather
// than waiting on the session's own broadcast — best-effort Realtime shouldn't strand the host.
export function HostConsole({
  code,
  total,
  initialIndex,
  initialStatus,
  initialSlide,
  initialAnswered,
  initialAggregate,
  initialCorrectId,
  initialExplanation,
  initialServerStartedAt,
  initialTimeLimitMs,
}: {
  code: string
  total: number
  initialIndex: number
  initialStatus: string
  initialSlide: SanitizedSlide | null
  initialAnswered: number
  initialAggregate: AggregateMcq | null
  initialCorrectId: string | null
  initialExplanation: string | null
  initialServerStartedAt: string | null
  initialTimeLimitMs: number | null
}) {
  const [status, setStatus] = useState<Status>(initialStatus as Status)
  const [index, setIndex] = useState(initialIndex)
  const [slide, setSlide] = useState<SanitizedSlide | null>(initialSlide)
  // Which slide the live counters below are allowed to be about. Kept as a ref, and written
  // in the same tick as setSlide rather than from an effect, so there is no frame in which a
  // broadcast for the incoming slide is judged against the outgoing one and dropped.
  const slideIdRef = useRef<string | null>(initialSlide?.id ?? null)
  // The server's start stamp for what's on screen, used to drop an out-of-order slide:show
  // (see the handler below). Same reasoning as the phone's copy in app/play/page.tsx: two
  // rapid advances publish independently and can arrive reversed, and this console follows
  // the room, not just its own clicks — a second host tab or the load harness moves it too.
  const startedAtRef = useRef<number>(
    initialServerStartedAt ? Date.parse(initialServerStartedAt) : 0,
  )
  const showSlide = useCallback((s: SanitizedSlide | null, serverStartedAt?: string | null) => {
    slideIdRef.current = s?.id ?? null
    if (serverStartedAt !== undefined) {
      startedAtRef.current = serverStartedAt ? Date.parse(serverStartedAt) : 0
    }
    setSlide(s)
  }, [])
  const [roster, setRoster] = useState<PresenceState[]>([])
  const [answered, setAnswered] = useState(initialAnswered)
  const [correctId, setCorrectId] = useState<string | null>(initialCorrectId)
  const [aggregate, setAggregate] = useState<AggregateMcq | null>(initialAggregate)
  const [explanation, setExplanation] = useState<string | null>(initialExplanation)
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([])
  // Restored on reload so a mid-question refresh keeps counting down instead of showing
  // nothing. Only meaningful while the question is open — reveal and lobby clear it.
  const [deadline, setDeadline] = useState<number | null>(() =>
    initialStatus === 'active' && initialServerStartedAt && initialTimeLimitMs
      ? Date.parse(initialServerStartedAt) + initialTimeLimitMs
      : null,
  )
  // The full window, kept so the drain bar knows what fraction is left. Without it the bar
  // would only know the remaining milliseconds, not the share.
  const [windowMs, setWindowMs] = useState<number | null>(initialTimeLimitMs)
  const [now, setNow] = useState(() => Date.now())
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
          setError(data?.error ?? 'That did not go through. Try again.')
          return null
        }
        return data
      } catch {
        setError('Network error. Try again.')
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
    showSlide(data.slide, data.serverStartedAt)
    // Re-showing an already-revealed slide comes back 'revealed' with its tally, so going
    // back to discuss a question shows the results again instead of a blank re-run.
    setStatus(data.status)
    setAggregate(data.aggregate ?? null)
    setCorrectId(data.correctOptionId ?? null)
    setExplanation(data.explanation ?? null)
    setAnswered(0) // live counter for a fresh question; a revealed slide reads its tally instead
    setWindowMs(data.timeLimitMs ?? null)
    setDeadline(
      data.status === 'active' ? Date.parse(data.serverStartedAt) + data.timeLimitMs : null,
    )
    setNow(Date.now())
  }

  async function reveal() {
    const data = await call('reveal')
    if (!data) return
    setStatus('revealed')
    setCorrectId(data.correctOptionId ?? null)
    setAggregate(data.aggregate)
    setExplanation(data.explanation ?? null)
    setLeaderboard(data.top)
    setDeadline(null)
  }

  async function kick(participantId: string) {
    await call('kick', { participantId })
    // Presence drops them when their phone leaves the channel, so the roster corrects
    // itself; no local list surgery to keep in sync with the server.
  }

  async function end() {
    const data = await call('end')
    if (!data) throw new Error('end failed') // DeleteButton surfaces the retry hint
    setStatus('ended')
    setLeaderboard(data.fullRanking)
  }

  // TWO subscriptions, split by audience, not by importance:
  //
  //   session:{code}        the room. Slide changes, reveals, leaderboard, end. Every phone
  //                         is on this one, so each event here costs ~1 message per phone.
  //   session:{code}:host   this screen only. The answered counter and the live poll chart,
  //                         which fire every second and which no participant renders. On the
  //                         room channel they were 100 phones decoding data they discard.
  //
  // Presence stays on the room channel: it's the participants' own writes that populate the
  // roster, so it has to live where the participants are.
  //
  // Every slide-addressed event checks `payload.slideId` against the slide actually on
  // screen — both live counters AND the reveal. Answers land continuously while the host is
  // clicking Next, so a broadcast for the outgoing slide routinely arrives after the incoming
  // slide:show has already reset the counter to 0; without the check it overwrites the new
  // slide's readout with the previous slide's number, or (on a reveal) closes a question the
  // room is still answering. Read through a ref because this effect subscribes once (deps are
  // [code]) and a handler closing over `slide` would see it frozen at mount.
  useEffect(() => {
    const supabase = createClient()
    const channel = openSessionChannel(supabase, code)
    const host = openHostChannel(supabase, code)
    const isCurrent = (payload: { slideId?: string }) =>
      !slideIdRef.current || payload.slideId === slideIdRef.current
    host
      .on('broadcast', { event: EVENTS.ANSWERED_COUNT }, ({ payload }) => {
        if (isCurrent(payload)) setAnswered(payload.answered)
      })
      // Unscored slides send the distribution itself while voting is open — this is the poll
      // filling in live. A scored question never sends it (see isScored), so an open quiz
      // can't reach here and leak its tally.
      .on('broadcast', { event: EVENTS.RESULTS_UPDATE }, ({ payload }) => {
        const p = payload as ResultsUpdatePayload
        if (isCurrent(p)) setAggregate(p.aggregate)
      })
      .subscribe()
    channel
      // The console also follows the room, not just its own button clicks. Without these it
      // goes stale whenever the session moves by any other route — a second host tab, or
      // the load-test harness driving over HTTP — and would then render one slide while the
      // server is on another.
      .on('broadcast', { event: EVENTS.SLIDE_SHOW }, ({ payload }) => {
        // Older than what's on screen → a reordered publish for a slide the room already
        // left. Applying it would put the console on one slide while the server is on
        // another, which is precisely what this handler exists to prevent.
        if (Date.parse(payload.serverStartedAt) < startedAtRef.current) return
        setIndex(payload.index)
        showSlide(payload.slide as SanitizedSlide, payload.serverStartedAt)
        setStatus(payload.status === 'revealed' ? 'revealed' : 'active')
        setAnswered(0)
        setCorrectId(null)
        setAggregate(null)
        setExplanation(null)
        setWindowMs(payload.timeLimitMs ?? null)
        setDeadline(
          payload.status === 'revealed'
            ? null
            : Date.parse(payload.serverStartedAt) + payload.timeLimitMs,
        )
        setNow(Date.now())
      })
      .on('broadcast', { event: EVENTS.SLIDE_REVEAL }, ({ payload }) => {
        const p = payload as SlideRevealPayload
        // Addressed to a slide like the two counters above, so it gets the same check. A
        // reveal for the OUTGOING slide arriving after the incoming slide:show would
        // otherwise mark a live question revealed and paint it with the previous slide's
        // tally and explanation — worse than a stale counter, because it closes the UI on a
        // question the room is still answering.
        if (!isCurrent(p)) return
        setStatus('revealed')
        setCorrectId(p.correctOptionId ?? null)
        setAggregate(p.aggregate)
        setExplanation(p.explanation ?? null)
        setDeadline(null)
      })
      .on('broadcast', { event: EVENTS.LEADERBOARD_UPDATE }, ({ payload }) => {
        setLeaderboard(payload.top as LeaderboardEntry[])
      })
      .on('broadcast', { event: EVENTS.SESSION_ENDED }, ({ payload }) => {
        setLeaderboard(payload.fullRanking as LeaderboardEntry[])
        setStatus('ended')
      })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState<PresenceState>()
        setRoster(Object.values(state).flatMap((entries) => entries.slice(0, 1)))
      })
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
      supabase.removeChannel(host)
    }
  }, [code, showSlide])

  // Tick only while a question is open; the countdown is the only thing that needs `now`.
  useEffect(() => {
    if (status !== 'active' || !deadline) return
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [status, deadline])

  const msLeft = status === 'active' && deadline ? Math.max(0, deadline - now) : null
  const secondsLeft = msLeft === null ? null : Math.ceil(msLeft / 1000)
  const fractionLeft = msLeft !== null && windowMs ? Math.min(1, msLeft / windowMs) : null
  const atLast = index >= total - 1
  // While a question is open the count comes from the leaky-bucket broadcast, which is a
  // throttled estimate — answers landing inside the same 1s window as the last one never
  // get their own message, so it can sit low. Once an aggregate exists (reveal, or a re-shown
  // revealed slide) it is the DB-authoritative count, so read the total off it. Derived
  // rather than assigned at each reveal path, so the readout can't disagree with the bars
  // drawn from that same aggregate.
  const answeredCount = aggregate?.total ?? answered
  // Unscored slides draw their results while the room is still voting; a quiz waits for the
  // reveal. Same predicate the server uses to decide what to broadcast, so the screen can't
  // show a chart the server never filled — or withhold one it did.
  const scored = slide ? isScored(slide.type) : true
  const showResults = slide !== null && (status === 'revealed' || !scored)
  const urgent = secondsLeft !== null && secondsLeft <= 5

  return (
    <main className="flex min-h-screen flex-col">
      {/* The drain. A full-width line at the very top is the one countdown cue that reads
          from the back of a hall without stealing space from the question. */}
      <div className="h-1.5 w-full shrink-0 bg-rule" aria-hidden suppressHydrationWarning>
        {fractionLeft !== null && (
          <div
            className={`h-full origin-left transition-[width] duration-200 ease-linear ${
              urgent ? 'bg-wrong' : 'bg-lamp'
            }`}
            style={{ width: `${fractionLeft * 100}%` }}
          />
        )}
      </div>

      <header className="flex flex-wrap items-end justify-between gap-8 border-b border-rule px-6 py-6 sm:px-10">
        <div>
          <div className={capCls} suppressHydrationWarning>
            Join at {typeof window === 'undefined' ? '' : window.location.host}/play
          </div>
          <div className="font-data mt-1 text-5xl leading-none tracking-[0.14em] text-lamp sm:text-6xl">
            {code}
          </div>
        </div>
        <div className="flex items-end gap-8 sm:gap-10">
          <Stat value={roster.length} label={roster.length === 1 ? 'player' : 'players'} />
          {status !== 'lobby' && status !== 'ended' && (
            <>
              <Stat value={answeredCount} label="answered" />
              {secondsLeft !== null && (
                <Stat value={secondsLeft} label="seconds" tone={urgent ? 'text-wrong' : 'text-lamp'} suppress />
              )}
            </>
          )}
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-10 px-6 py-10 sm:px-10">
        {status === 'lobby' && (
          <section className="flex flex-1 flex-col items-center justify-center gap-8 text-center">
            <div>
              <h2 className="font-display text-4xl sm:text-5xl">
                {roster.length === 0 ? 'Waiting for the room' : 'Ready when you are'}
              </h2>
              <p className="mt-3 text-lg text-dim">
                {roster.length === 0
                  ? 'Students join by entering the code above on their phones.'
                  : `${roster.length} ${roster.length === 1 ? 'person is' : 'people are'} in.`}
              </p>
            </div>
            {roster.length > 0 && <Roster roster={roster} onKick={kick} busy={busy} />}
          </section>
        )}

        {status === 'ended' ? (
          <section className="flex flex-col gap-10">
            <h2 className="font-display text-center text-4xl sm:text-5xl">
              Final standings
            </h2>
            {leaderboard.length > 0 ? (
              <Podium ranking={leaderboard} />
            ) : (
              <p className="text-center text-dim">Nobody scored. No players joined.</p>
            )}
            <p className="text-center text-sm text-dim">
              Session ended. The code is free for reuse.
            </p>
          </section>
        ) : (
          <>
            {slide && (
              <section className="flex flex-col gap-8">
                {showResults ? (
                  <>
                    <h2 className="font-display max-w-[22ch] text-4xl leading-[1.1] sm:text-5xl lg:text-6xl">
                      {slide.prompt}
                    </h2>
                    <ResultsChart slide={slide} aggregate={aggregate} correctId={correctId} />
                  </>
                ) : (
                  <ProjectorSlide prompt={slide.prompt} options={slide.options} />
                )}
                {status === 'revealed' && explanation && (
                  <p className="rounded-plate border-l-2 border-lamp bg-raised px-6 py-5 text-xl leading-relaxed text-dim">
                    {explanation}
                  </p>
                )}
              </section>
            )}

            {/* Scored slides only. A poll awards nothing, so the standings are unchanged from
                the last question — putting them up right after one reads as if the poll scored. */}
            {status === 'revealed' && scored && leaderboard.length > 0 && (
              <section>
                <h3 className={`${capCls} mb-4`}>Leaderboard</h3>
                <Leaderboard entries={leaderboard} />
              </section>
            )}

            {/* Mid-game access to the same remove control. A native <details> so there's no
                open/closed state to hold, and it stays collapsed on the projector until the
                host actually needs it. Only rendered once the lobby roster is gone. */}
            {status !== 'lobby' && roster.length > 0 && (
              <details className="text-sm">
                <summary className="cursor-pointer text-dim hover:text-ink">
                  Players ({roster.length})
                </summary>
                <div className="pt-4">
                  <Roster roster={roster} onKick={kick} busy={busy} />
                </div>
              </details>
            )}
          </>
        )}
      </div>

      {status !== 'ended' && (
        <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t border-rule bg-ground/95 px-6 py-4 backdrop-blur sm:px-10">
          {status === 'lobby' ? (
            <button onClick={() => goTo(0)} disabled={busy || total === 0} className={btn('primary', 'xl')}>
              {busy ? 'Starting' : 'Start the session'}
            </button>
          ) : (
            <>
              <button onClick={() => goTo(index - 1)} disabled={busy || index <= 0} className={btn('secondary', 'lg')}>
                Back
              </button>
              {status === 'active' && (
                <button onClick={reveal} disabled={busy} className={btn('primary', 'xl')}>
                  {/* Same endpoint either way — it closes the answer window. On a quiz that
                      also discloses the key, which is the whole event; on a poll there is
                      nothing to disclose, so calling it "Reveal" would promise a result the
                      room has been watching for the last 30 seconds. */}
                  {scored ? 'Reveal the answer' : 'Close voting'}
                </button>
              )}
              <button onClick={() => goTo(index + 1)} disabled={busy || atLast} className={btn('secondary', 'lg')}>
                {status === 'active' ? 'Skip' : 'Next'}
              </button>
              <span className="font-data text-sm text-dim">
                {index + 1} / {total}
              </span>
            </>
          )}
          <div className="ml-auto">
            <DeleteButton
              action={end}
              confirmText="End this session for everyone?"
              label="End session"
              pendingLabel="Ending"
              className={btn('danger', 'md')}
            />
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="px-6 pb-4 text-sm text-wrong sm:px-10">
          {error}
        </p>
      )}
    </main>
  )
}

/** The room, with a remove control on every player. Shared by the lobby (where it's the main
 *  event) and the in-game disclosure below the controls — a bad nickname is at its most
 *  visible once that player is on the leaderboard, which is exactly when the lobby is gone. */
function Roster({
  roster,
  onKick,
  busy,
}: {
  roster: PresenceState[]
  onKick: (participantId: string) => void
  busy: boolean
}) {
  return (
    <ul className="flex flex-wrap justify-center gap-2.5">
      {roster.map((p) => (
        <li
          key={p.participantId}
          className="group flex items-center gap-2 rounded-full border border-rule bg-raised py-1.5 pl-1.5 pr-2 text-lg"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={avatarUrl(p.avatarSeed)} alt="" className="h-8 w-8 rounded-full bg-overlay" />
          <span className="font-semibold">{p.nickname}</span>
          <button
            onClick={() => onKick(p.participantId)}
            disabled={busy}
            // The nickname is in the label, not just the glyph, so a screen reader announces
            // WHICH player this removes — there is one of these per person on screen.
            aria-label={`Remove ${p.nickname}`}
            title={`Remove ${p.nickname}`}
            className="rounded-full p-1 text-faint transition-colors hover:bg-wrong/15 hover:text-wrong disabled:opacity-40"
          >
            <X size={14} weight="regular" />
          </button>
        </li>
      ))}
    </ul>
  )
}

function Stat({
  value,
  label,
  tone,
  suppress,
}: {
  value: number
  label: string
  tone?: string
  /** Clock-derived values differ between the server render and the client's first paint. */
  suppress?: boolean
}) {
  return (
    <div>
      <div
        suppressHydrationWarning={suppress}
        className={`font-data text-4xl leading-none tabular-nums sm:text-5xl ${tone ?? 'text-ink'}`}
      >
        {value}
      </div>
      <div className={`${capCls} mt-2`}>{label}</div>
    </div>
  )
}
