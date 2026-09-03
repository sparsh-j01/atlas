'use client'

import { useRef, useState, useTransition } from 'react'
import { btn } from '@/components/ui'

// Two-step trigger for a bound server action. Used for deck + slide deletes and for ending
// a live session (all destructive, all cascading), so a stray click can't destroy content.
//
// Arm-then-confirm rather than window.confirm(): the host console mounts one of these while
// a session is live, and a native dialog blocks the whole page — the projector freezes and
// the realtime channel stalls behind it until someone walks over and dismisses it. This
// stays inside the page, styles with the rest of the UI, and Escape backs out of it.
//
// Surfaces pending + failure state so a rejected delete doesn't silently re-enable the
// button with no feedback.
export function DeleteButton({
  action,
  confirmText,
  label = 'Delete',
  pendingLabel = 'Deleting',
  name,
  className = btn('danger', 'md'),
}: {
  action: () => Promise<void>
  /** The question asked once the button is armed. Shown next to it, not in it. */
  confirmText: string
  label?: string
  pendingLabel?: string
  /**
   * What this one deletes ("slide 3", a deck title). Appended to the accessible name
   * wherever these repeat — a list of rows each offering a bare "Delete" tells a screen
   * reader user nothing about which row they are on. Omit for a lone instance.
   */
  name?: string
  className?: string
}) {
  const [pending, startTransition] = useTransition()
  const [failed, setFailed] = useState(false)
  const [armed, setArmed] = useState(false)
  const wrap = useRef<HTMLSpanElement>(null)
  // The visible text, so the aria-label below is built from it rather than restating it —
  // a fixed label would keep announcing "Delete" after the button had already armed to
  // "Confirm", which is the one state change that matters here.
  const text = pending ? pendingLabel : armed ? 'Confirm' : label

  return (
    <span
      ref={wrap}
      className="inline-flex items-center gap-2"
      onKeyDown={(e) => e.key === 'Escape' && setArmed(false)}
      // Disarm when focus leaves the pair entirely, so an armed button never sits waiting
      // on a screen the user has moved on from. relatedTarget is the element receiving
      // focus; null (clicked the page background) also counts as leaving.
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget)) setArmed(false)
      }}
    >
      {armed && !pending && (
        <span role="alert" className="text-sm text-dim">
          {confirmText}
        </span>
      )}
      <button
        type="button"
        disabled={pending}
        aria-label={name ? `${text} ${name}` : undefined}
        className={className}
        onClick={() => {
          if (!armed) {
            setArmed(true)
            return
          }
          startTransition(async () => {
            setFailed(false)
            try {
              await action()
              setArmed(false)
            } catch {
              setFailed(true)
              setArmed(false)
            }
          })
        }}
      >
        {text}
      </button>
      {failed && (
        <span role="alert" className="text-sm text-wrong">
          That did not go through. Try again.
        </span>
      )}
    </span>
  )
}
