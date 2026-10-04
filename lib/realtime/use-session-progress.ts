'use client'

import { useEffect } from 'react'
import { ANSWER_GRACE_MS } from './session-state'
import type { ProgressState } from './session-progress'

/** One wake-up per deadline, with retries. Participant fallbacks are delayed and spread
 * out; a normal slide broadcast cancels them before they make any request. */
export function useSessionProgress({ code, clientToken, status, index, serverStartedAt, timeLimitMs, onProgress, onError }: {
  code: string
  clientToken?: string
  status: string
  index: number
  serverStartedAt: string | null
  timeLimitMs: number | null
  onProgress: (state: ProgressState) => void
  onError: (message: string) => void
}) {
  useEffect(() => {
    if (status !== 'active' || !serverStartedAt || !timeLimitMs) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const controller = new AbortController()
    const due = Date.parse(serverStartedAt) + timeLimitMs + ANSWER_GRACE_MS
    // The host console wakes the room 30 ms after the deadline. A phone is only the backup
    // for a host tab that is asleep, so it waits until the room would long since have moved:
    // at 1.2–2 s every phone in a 120-student load test fired before the broadcast landed.
    const fallbackDelay = clientToken ? 4000 + Math.random() * 2000 : 30
    async function wake() {
      try {
        const res = await fetch(`/api/sessions/${code}/progress`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(clientToken ? { Authorization: `Bearer ${clientToken}` } : {}) },
          body: JSON.stringify({ index, serverStartedAt }),
          signal: controller.signal,
        })
        const data = await res.json().catch(() => null)
        if (cancelled) return
        if (!res.ok || !data) throw new Error('Could not advance the quiz. Retrying…')
        // Early (this device's clock runs fast): the server says how long is left by ITS clock.
        // Sleep exactly that, plus the same stagger, instead of asking again every second.
        if (typeof data.waitMs === 'number') {
          timer = setTimeout(wake, data.waitMs + fallbackDelay)
          return
        }
        onProgress(data)
        // Lost a race with another wake that had not committed yet: look once more.
        if (data.status === 'active' && data.index === index && data.serverStartedAt === serverStartedAt) {
          timer = setTimeout(wake, 1000)
        }
      } catch {
        if (cancelled) return
        onError('Connection interrupted. Reconnecting to the quiz…')
        timer = setTimeout(wake, 2000)
      }
    }
    const resume = () => {
      if (Date.now() < due) return
      clearTimeout(timer)
      timer = setTimeout(wake, fallbackDelay)
    }
    timer = setTimeout(wake, Math.max(0, due - Date.now()) + fallbackDelay)
    window.addEventListener('focus', resume)
    document.addEventListener('visibilitychange', resume)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
      window.removeEventListener('focus', resume)
      document.removeEventListener('visibilitychange', resume)
    }
  }, [code, clientToken, status, index, serverStartedAt, timeLimitMs, onProgress, onError])
}
