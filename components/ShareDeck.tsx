'use client'

import { useState, useTransition } from 'react'
import { setDeckSharedAction } from '@/lib/actions'
import { useIsClient } from '@/lib/use-is-client'
import { btn, inputCls, panelCls } from '@/components/ui'

/**
 * The deck's public link: off by default, on by a toggle, revocable.
 *
 * The URL is built in the browser from `location.origin` rather than passed down from the
 * server, because it exists only to be copied by the person looking at it — the server does
 * not need to know the host, and threading it through would be a prop for a string the
 * clipboard is about to eat. It renders empty until mount for that reason, which is fine:
 * the field is disabled until sharing is on anyway.
 */
export function ShareDeck({ deckId, initialToken }: { deckId: string; initialToken: string | null }) {
  const [token, setToken] = useState(initialToken)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Guarded by useIsClient rather than read in an effect: `window` genuinely does not exist
  // during the server pass, and the flag is what makes reading it here safe.
  const isClient = useIsClient()
  const url = token && isClient ? `${window.location.origin}/d/${token}` : ''

  function set(shared: boolean) {
    setError(null)
    setCopied(false)
    startTransition(async () => {
      try {
        const res = await setDeckSharedAction(deckId, shared)
        setToken(res.token)
      } catch {
        setError('Could not change the link. Try again.')
      }
    })
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access can be refused (insecure origin, permission). The field is
      // selectable, so say so instead of failing silently.
      setError('Copy blocked by the browser. Select the link and copy it manually.')
    }
  }

  return (
    <section className={`${panelCls} mt-4 px-5 py-4`}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">{token ? 'Shared by link' : 'Not shared'}</h2>
          <p className="mt-0.5 text-sm leading-relaxed text-dim">
            {token
              ? 'Anyone with the link can read this deck and its correct answers, without signing in. Do not give it to a class you are about to present it to.'
              : 'Create a read-only link to send another teacher. It shows the questions and the correct answers, so it is off until you turn it on.'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => set(!token)}
          disabled={pending}
          className={btn(token ? 'ghost' : 'secondary', 'md')}
        >
          {token ? 'Stop sharing' : 'Create link'}
        </button>
      </div>

      {token && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <label htmlFor="share-url" className="sr-only">
            Public link to this deck
          </label>
          <input
            id="share-url"
            readOnly
            value={url}
            // Selects the whole link on focus, so the keyboard path is focus then Ctrl+C
            // rather than a drag across a long token.
            onFocus={(e) => e.currentTarget.select()}
            // No font-mono: docs/design.md §9 dropped the mono face from the app entirely,
            // so the utility would fall back to Tailwind's default stack — a fourth family
            // on a screen that has three. A share URL is copied, not read character by
            // character, so it has nothing to disambiguate.
            className={`${inputCls} min-w-0 flex-1 text-sm`}
          />
          <button type="button" onClick={copy} className={btn('secondary', 'md')}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          {/* Rotating is the only revoke: minting a new token orphans every copy of the old
              link that is already out there. Worth its own control, because "stop sharing
              then share again" is not obviously the same thing. */}
          <button
            type="button"
            onClick={() => set(true)}
            disabled={pending}
            className={btn('ghost', 'md')}
          >
            New link
          </button>
        </div>
      )}

      {/* A live region: both the copy confirmation and the failure land here after a click
          that moves no focus, so a screen reader would otherwise hear nothing happen. */}
      <p role="status" className="sr-only">
        {copied ? 'Link copied' : ''}
      </p>
      {error && (
        <p role="alert" className="mt-3 text-sm text-wrong">
          {error}
        </p>
      )}
    </section>
  )
}
