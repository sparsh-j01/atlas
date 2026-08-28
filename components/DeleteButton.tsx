'use client'

import { useState, useTransition } from 'react'
import { btn } from '@/components/ui'

// Confirm-guarded trigger for a bound server action. Used for deck + slide deletes
// (both cascade), so a stray click can't destroy content. Surfaces pending + failure
// state so a rejected delete doesn't silently re-enable the button with no feedback.
export function DeleteButton({
  action,
  confirmText,
  label = 'Delete',
  pendingLabel = 'Deleting',
  className = btn('danger', 'md'),
}: {
  action: () => Promise<void>
  confirmText: string
  label?: string
  pendingLabel?: string
  className?: string
}) {
  const [pending, startTransition] = useTransition()
  const [failed, setFailed] = useState(false)

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={pending}
        className={className}
        onClick={() => {
          if (!confirm(confirmText)) return
          startTransition(async () => {
            setFailed(false)
            try {
              await action()
            } catch {
              setFailed(true)
            }
          })
        }}
      >
        {pending ? pendingLabel : label}
      </button>
      {failed && (
        <span role="alert" className="text-sm text-wrong">
          That did not go through. Try again.
        </span>
      )}
    </span>
  )
}
