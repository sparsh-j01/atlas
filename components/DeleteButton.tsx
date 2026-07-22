'use client'

// Confirm-guarded submit for a bound server action. Used for deck + slide deletes
// (both cascade), so a stray click can't destroy content.
export function DeleteButton({
  action,
  confirmText,
  label = 'Delete',
  className = 'text-sm text-red-600 hover:underline',
}: {
  action: () => Promise<void>
  confirmText: string
  label?: string
  className?: string
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(confirmText)) e.preventDefault()
      }}
    >
      <button type="submit" className={className}>
        {label}
      </button>
    </form>
  )
}
