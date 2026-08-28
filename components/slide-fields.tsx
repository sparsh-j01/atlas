'use client'

import { useState, useTransition } from 'react'
import { saveSlideAction } from '@/lib/actions'
import { TIME_MAX_MS, TIME_MIN_MS } from '@/lib/mcq'
import { validateSlide, type EditableSlide } from '@/lib/slides'
import { btn, capCls, inputCls } from '@/components/ui'

// Pieces every slide editor shares. Lives in its own module so SlideCard can import the
// per-type editors without them importing it back — the dependency runs one way:
// slide-fields ← {SlideCard, PollCard}, and SlideCard ← PollCard.

export const inputClass = inputCls

/**
 * Local draft state + the save round-trip. The draft carries its own `type`, so the same
 * hook serves every editor and `validateSlide` dispatches on it — which is what stops a poll
 * draft from being validated by the MCQ rules (or vice versa) as types get added.
 */
export function useSlideDraft<T extends EditableSlide>(deckId: string, slideId: string, initial: T) {
  const [draft, setDraft] = useState<T>(initial)
  const [pending, startTransition] = useTransition()
  const [serverErrors, setServerErrors] = useState<string[]>([])
  const [saved, setSaved] = useState(false)

  function patch(p: Partial<T>) {
    setDraft((prev) => ({ ...prev, ...p }))
    setSaved(false)
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await saveSlideAction(deckId, slideId, draft)
        setServerErrors(res.errors)
        setSaved(res.errors.length === 0)
      } catch {
        setServerErrors(['Save failed. Please retry.'])
        setSaved(false)
      }
    })
  }

  // Guard the numeric fields: skip non-finite parses so a bad value never round-trips
  // into the controlled input as "NaN".
  function patchNumber(patchFor: (n: number) => Partial<T>, raw: string) {
    const n = Number(raw)
    if (Number.isFinite(n)) patch(patchFor(n))
  }

  return { draft, patch, patchNumber, save, pending, saved, errors: validateSlide(draft), serverErrors }
}

/** Inline validation list + the save button. Client-side errors and whatever the server
 *  sent back are merged, so a rule that only exists server-side still surfaces here. */
export function SlideCardFooter({
  errors,
  serverErrors,
  pending,
  saved,
  save,
}: {
  errors: string[]
  serverErrors: string[]
  pending: boolean
  saved: boolean
  save: () => void
}) {
  return (
    <>
      {(errors.length > 0 || serverErrors.length > 0) && (
        <ul className="flex flex-col gap-1 text-sm text-wrong">
          {[...new Set([...errors, ...serverErrors])].map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || errors.length > 0}
          className={btn('primary', 'sm')}
        >
          {pending ? 'Saving' : 'Save slide'}
        </button>
        {saved && !pending && <span className="text-sm text-correct">Saved</span>}
      </div>
    </>
  )
}

/** The answer window, in seconds. Same bounds for every type (lib/mcq TIME_MIN_MS/TIME_MAX_MS),
 *  because they're enforced by the one shared validator. */
export function TimeLimitField({
  timeLimitMs,
  onChange,
}: {
  timeLimitMs: number
  onChange: (raw: string) => void
}) {
  return (
    <label className="flex items-center gap-2">
      <span className={capCls}>Time (s)</span>
      <input
        type="number"
        // From the same constants validateOptionSlide enforces, in seconds. Hardcoding them
        // meant the input could silently accept a value the save then rejected.
        min={TIME_MIN_MS / 1000}
        max={TIME_MAX_MS / 1000}
        className={`${inputClass} w-20 font-data`}
        value={Math.round(timeLimitMs / 1000)}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

/** The option rows shared by MCQ and poll. MCQ passes a `lead` (the correct-answer radio);
 *  a poll passes nothing, which is the entire difference between the two lists. */
export function OptionRows({
  options,
  min,
  max,
  onChangeText,
  onRemove,
  onAdd,
  lead,
}: {
  options: { id: string; text: string }[]
  min: number
  max: number
  onChangeText: (id: string, text: string) => void
  onRemove: (id: string) => void
  onAdd: () => void
  lead?: (id: string) => React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      {options.map((o) => (
        <div key={o.id} className="flex items-center gap-2">
          {lead?.(o.id)}
          <input
            className={inputClass}
            placeholder="Option text"
            value={o.text}
            onChange={(e) => onChangeText(o.id, e.target.value)}
          />
          <button
            type="button"
            onClick={() => onRemove(o.id)}
            disabled={options.length <= min}
            className="rounded-plate px-2.5 py-2 text-faint transition-colors hover:bg-wrong/10 hover:text-wrong disabled:opacity-30"
            aria-label="Remove option"
            title="Remove option"
          >
            ✕
          </button>
        </div>
      ))}
      {options.length < max && (
        <button
          type="button"
          onClick={onAdd}
          className={`${btn('ghost', 'sm')} self-start -ml-3`}
        >
          Add option
        </button>
      )}
    </div>
  )
}
