'use client'

import { useEffect, useRef } from 'react'

// Cloudflare Turnstile, the bot check in front of every auth form. Its token goes to Supabase
// Auth's own CAPTCHA verification (Auth → Attack Protection), so there is no server code of
// ours that checks it — Supabase rejects a missing or bad token itself.
//
// Off until NEXT_PUBLIC_TURNSTILE_SITE_KEY is set: renders nothing, the forms send no token,
// and that is correct as long as CAPTCHA is also off in Supabase. Turn both on together.
//
// No package: the widget is one script tag and three calls.

export const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim() || ''

type TurnstileApi = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string
  reset: (id: string) => void
  remove: (id: string) => void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
let loading: Promise<TurnstileApi> | null = null

function load(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SRC
    s.async = true
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')))
    s.onerror = () => {
      loading = null
      reject(new Error('turnstile failed to load'))
    }
    document.head.appendChild(s)
  })
  return loading
}

/**
 * The widget. `onToken` gets a token when the check passes and null when it expires or errors.
 * A token is single-use, so bump `resetKey` after every submission to get a fresh one.
 */
export function Turnstile({ onToken, resetKey = 0 }: { onToken: (token: string | null) => void; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  const latest = useRef(onToken)
  useEffect(() => {
    latest.current = onToken
  })

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !box.current) return
    let cancelled = false
    load()
      .then((ts) => {
        if (cancelled || !box.current) return
        widget.current = ts.render(box.current, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (t: string) => latest.current(t),
          'expired-callback': () => latest.current(null),
          'error-callback': () => latest.current(null),
        })
      })
      .catch(() => latest.current(null))
    return () => {
      cancelled = true
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = null
    }
  }, [])

  useEffect(() => {
    if (resetKey && widget.current) {
      latest.current(null)
      window.turnstile?.reset(widget.current)
    }
  }, [resetKey])

  if (!TURNSTILE_SITE_KEY) return null
  return <div ref={box} className="min-h-[65px]" />
}
