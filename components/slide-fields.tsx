'use client'

import { X } from '@phosphor-icons/react/ssr'
import { useEffect, useState, useTransition } from 'react'
import { saveSlideAction } from '@/lib/actions'
import { TIME_MAX_MS, TIME_MIN_MS } from '@/lib/mcq'
import { validateSlide, type EditableSlide } from '@/lib/slides'
import { btn, capCls, inputCls } from '@/components/ui'

// Pieces every slide editor shares. Lives in its own module so SlideCard can import the
// per-type editors without them importing it back — the dependency runs one way:
// slide-fields ← {SlideCard, PollCard}, and SlideCard ← PollCard.

export const inputClass = inputCls

/**
 * Slide ids with unsaved edits. A module-level set rather than a context: every editor
 * already imports this module, one deck is open at a time, and the alternative is a
 * provider plus a wrapper Link for a single boolean.
 */
const dirtySlides = new Set<string>()

/** True while any mounted slide editor holds edits that have not been saved. */
export function hasUnsavedSlides() {
  return dirtySlides.size > 0
}

/**
 * Warns before a reload, a tab close, or a click on a link out of the editor.
 * `beforeunload` covers leaving the site; `onNavigate` on the link covers the client-side
 * navigation that beforeunload never sees (Next 16 Link API) — the editor's "Back to your
 * decks" is exactly that case, and it was the one that actually lost work.
 */
export function useUnsavedSlidesWarning() {
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsavedSlides()) return
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
}

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
  const [dirty, setDirty] = useState(false)

  // Slide bodies save on a button while the deck header saves on blur, so the screen
  // teaches the wrong model and a typed-but-unsaved slide used to vanish on navigate.
  // Registering here rather than in DeckEditor keeps it right for every editor type and
  // for however many cards are mounted — the set is what the leave guard reads.
  useEffect(() => {
    if (!dirty) return
    dirtySlides.add(slideId)
    return () => {
      dirtySlides.delete(slideId)
    }
  }, [dirty, slideId])

  function patch(p: Partial<T>) {
    setDraft((prev) => ({ ...prev, ...p }))
    setSaved(false)
    setDirty(true)
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await saveSlideAction(deckId, slideId, draft)
        setServerErrors(res.errors)
        setSaved(res.errors.length === 0)
        if (res.errors.length === 0) setDirty(false)
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
  name,
  errors,
  serverErrors,
  pending,
  saved,
  save,
}: {
  /** Which slide this footer belongs to, e.g. "slide 3". Every card renders one of these,
   *  so an unscoped "Save slide" is the same button name once per slide on the page. */
  name: string
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
          aria-label={pending ? `Saving ${name}` : `Save ${name}`}
          className={btn('primary', 'sm')}
        >
          {pending ? 'Saving' : 'Save slide'}
        </button>
        {/* role=status, not a bare span: this is the only confirmation a save happened,
            and without a live region a screen reader never hears it.
            --pen, not --correct: docs/design.md §3 reserves correct/wrong for graded
            answers after a reveal. A saved slide is not a right answer. */}
        <span role="status" className="text-sm text-pen-ink">
          {saved && !pending ? 'Saved' : ''}
        </span>
      </div>
    </>
  )
}

/** The answer window, in seconds. Same bounds for every type (lib/mcq TIME_MIN_MS/TIME_MAX_MS),
 *  because they're enforced by the one shared validator. */
export function TimeLimitField({
  name,
  timeLimitMs,
  onChange,
}: {
  /** Which slide's window this is — one of these per card, all otherwise called "Time (s)". */
  name: string
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
        aria-label={`Time limit in seconds for ${name}`}
        className={`${inputClass} w-20 tabular`}
        value={Math.round(timeLimitMs / 1000)}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  )
}

/** The option rows shared by MCQ and poll. MCQ passes a `lead` (the correct-answer radio);
 *  a poll passes nothing, which is the entire difference between the two lists. */
export function OptionRows({
  name,
  options,
  min,
  max,
  onChangeText,
  onRemove,
  onAdd,
  lead,
}: {
  /**
   * Which slide these rows belong to, e.g. "slide 3". Every field and button below repeats
   * once per option AND once per slide card on the page — twenty text inputs whose only
   * accessible name was the shared placeholder "Option text", which is twenty identical
   * announcements with no way to tell which slide or which option is focused.
   */
  name: string
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
      {options.map((o, i) => (
        <div key={o.id} className="flex items-center gap-2">
          {lead?.(o.id)}
          <input
            className={`${inputClass} w-full`}
            placeholder="Option text"
            // Position, not the option's own text: this is the field you are typing INTO, and
            // a name that changes with every keystroke is re-announced on every keystroke.
            // The buttons beside it, which act on a settled value, do use the text.
            aria-label={`Option ${i + 1} of ${name}`}
            value={o.text}
            onChange={(e) => onChangeText(o.id, e.target.value)}
          />
          <button
            type="button"
            onClick={() => onRemove(o.id)}
            disabled={options.length <= min}
            className="grid size-11 shrink-0 place-items-center rounded-pill text-faint transition-colors hover:bg-wrong-wash hover:text-wrong disabled:opacity-30"
            aria-label={`Remove ${o.text.trim() || `option ${i + 1}`} from ${name}`}
            title="Remove option"
          >
            <X size={14} weight="regular" />
          </button>
        </div>
      ))}
      {options.length < max && (
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Add option to ${name}`}
          className={`${btn('ghost', 'sm')} self-start -ml-3`}
        >
          Add option
        </button>
      )}
    </div>
  )
}
