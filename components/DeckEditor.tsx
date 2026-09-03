'use client'

import { CaretDown, CaretUp, DotsSixVertical, Plus } from '@phosphor-icons/react/ssr'
import { useOptimistic, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { SlideCard, type EditorSlide } from '@/components/SlideCard'
import { hasUnsavedSlides, useUnsavedSlidesWarning } from '@/components/slide-fields'
import { DeleteButton } from '@/components/DeleteButton'
import { btn, capCls, inputCls, panelCls, statusDotCls } from '@/components/ui'
import {
  addSlideAction,
  deleteSlideAction,
  reorderSlidesAction,
  setDeckStatusAction,
  updateDeckAction,
} from '@/lib/actions'
import { isSlideType, SLIDE_TYPE_LABEL, SLIDE_TYPES } from '@/lib/slides'

type EditorDeck = { id: string; title: string; description: string | null; status: string }

export function DeckEditor({ deck, slides }: { deck: EditorDeck; slides: EditorSlide[] }) {
  const [title, setTitle] = useState(deck.title)
  const [description, setDescription] = useState(deck.description ?? '')
  const [status, setStatus] = useState(deck.status)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [leaveWarned, setLeaveWarned] = useState(false)
  const [, startTransition] = useTransition()

  // Reload / tab close. The in-app link is guarded separately below — beforeunload does
  // not fire for a client-side navigation.
  useUnsavedSlidesWarning()

  // Server positions are the source of truth (each reorder persists + revalidates);
  // useOptimistic just makes a drag feel instant during the round-trip. Deriving from
  // `slides` also means add/delete need no manual reconciliation.
  const byId = new Map(slides.map((s) => [s.id, s]))
  const [ordered, reorderOptimistic] = useOptimistic(slides, (_prev, newOrder: string[]) =>
    newOrder.map((id) => byId.get(id)).filter((s): s is EditorSlide => Boolean(s)),
  )

  const liRefs = useRef<Record<string, HTMLLIElement | null>>({})
  const dragId = useRef<string | null>(null)

  // Fire-and-forget server actions surface failures here instead of vanishing as
  // unhandled rejections — the optimistic UI would otherwise silently revert.
  function run(p: Promise<unknown>, msg: string) {
    p.then(() => setActionError(null)).catch(() => setActionError(msg))
  }

  function persistOrder(next: string[]) {
    startTransition(() => {
      reorderOptimistic(next)
      run(reorderSlidesAction(deck.id, next), 'Could not save the new order. Please retry.')
    })
  }

  function onDrop(targetId: string) {
    const from = dragId.current
    if (!from || from === targetId) return
    const next = ordered.map((s) => s.id).filter((id) => id !== from)
    const idx = next.indexOf(targetId)
    next.splice(idx < 0 ? next.length : idx, 0, from)
    persistOrder(next)
  }

  // Keyboard-accessible reorder for keyboard/assistive-tech users — same persist path as drag.
  function move(id: string, dir: -1 | 1) {
    const ids = ordered.map((s) => s.id)
    const i = ids.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    persistOrder(ids)
  }

  function toggleStatus() {
    const next = status === 'ready' ? 'draft' : 'ready'
    startTransition(async () => {
      const res = await setDeckStatusAction(deck.id, next)
      if (res.error) setStatusError(res.error)
      else {
        setStatus(next)
        setStatusError(null)
      }
    })
  }

  const ready = status === 'ready'

  return (
    <div className="mx-auto max-w-3xl px-6 py-12">
      {/* The title and description above save on blur, but slide bodies save on a button —
          so leaving with an unsaved slide used to discard it with no warning. Stop the first
          click, say what is unsaved, let the second one through. Same arm-then-confirm shape
          as DeleteButton, and no blocking dialog. */}
      <div className="flex flex-wrap items-baseline gap-3">
        <Link
          href="/dashboard"
          className="text-sm text-dim transition-colors hover:text-ink"
          onNavigate={(e) => {
            if (leaveWarned || !hasUnsavedSlides()) return
            e.preventDefault()
            setLeaveWarned(true)
            // Disarm after a few seconds so the guard asks again next time. Without this
            // one dismissal covers the rest of the session, including slides edited after
            // it — which is the case that loses work.
            setTimeout(() => setLeaveWarned(false), 6000)
          }}
        >
          Back to your decks
        </Link>
        {leaveWarned && (
          <span role="alert" className="text-sm text-wrong">
            A slide has unsaved edits. Click again to leave without saving.
          </span>
        )}
      </div>

      {/* The page's h1. The editor is the densest screen in the app and had NO headings at
          all — an empty document outline, nothing announcing what the page was, and no way
          to navigate it by heading. The visible title has to stay an editable field (an
          <input> inside a heading contributes no accessible name), so the heading is
          off-screen and renders the same state, which is what keeps the two in step. */}
      <h1 className="sr-only">{title || 'Untitled deck'}</h1>

      <div className="mt-6 flex flex-col gap-3">
        <input
          className={`${inputCls} font-display border-transparent bg-transparent px-0 text-3xl hover:border-transparent focus:border-transparent`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => run(updateDeckAction(deck.id, { title }), 'Could not save the title.')}
          placeholder="Untitled deck"
          aria-label="Deck title"
        />
        <textarea
          className={`${inputCls} resize-y border-transparent bg-transparent px-0 text-dim hover:border-transparent focus:border-transparent`}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() =>
            run(
              updateDeckAction(deck.id, { description: description || null }),
              'Could not save the description.',
            )
          }
          placeholder="Add a description"
          rows={2}
          aria-label="Deck description"
        />
      </div>

      {/* The ready gate. It is what unlocks Present, so it gets its own bar rather than a
          pill lost in the header. */}
      <div
        className={`${panelCls} mt-4 flex flex-wrap items-center gap-4 px-5 py-4 ${
          ready ? 'border-pen/40' : ''
        }`}
      >
        <span aria-hidden className={statusDotCls(ready)} />
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{ready ? 'Ready to present' : 'Draft'}</p>
          <p className="mt-0.5 text-sm text-dim">
            {ready
              ? 'This deck can host a live session.'
              : 'Every slide has to pass validation before this deck can host.'}
          </p>
        </div>
        <button type="button" onClick={toggleStatus} className={btn(ready ? 'ghost' : 'primary', 'md')}>
          {ready ? 'Back to draft' : 'Mark ready'}
        </button>
      </div>

      {statusError && (
        <p role="alert" className="mt-3 text-sm text-wrong">
          {statusError}
        </p>
      )}
      {actionError && (
        <p role="alert" className="mt-3 text-sm text-wrong">
          {actionError}
        </p>
      )}

      <ul className="mt-8 flex flex-col gap-4">
        {ordered.map((s, i) => {
          // One name for everything inside this card. Every repeated control below (delete,
          // add option, save, and each option field) carries it, so a screen reader hears
          // which slide it is acting on instead of the same four verbs once per slide.
          const slideName = `slide ${i + 1}`
          const typeLabel = isSlideType(s.type) ? SLIDE_TYPE_LABEL[s.type] : s.type
          return (
          <li
            key={s.id}
            ref={(el) => {
              liRefs.current[s.id] = el
            }}
            onDragStart={() => {
              dragId.current = s.id
            }}
            onDragEnd={() => {
              const el = liRefs.current[s.id]
              if (el) el.draggable = false
              dragId.current = null
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => onDrop(s.id)}
            className={`${panelCls} p-5`}
          >
            <div className="mb-4 flex items-center gap-1 border-b border-rule pb-3">
              {/* Pointer-only affordance: mousedown arms the native drag. It is aria-hidden
                  and out of the tab order on purpose — as a focusable button it announced
                  "Drag to reorder" and then did nothing on Enter. The two carets beside it
                  are the keyboard and touch path, and they run the same persist. */}
              <span
                aria-hidden
                tabIndex={-1}
                className="grid size-11 shrink-0 cursor-grab place-items-center rounded-pill text-faint transition-colors hover:text-ink"
                onMouseDown={() => {
                  const el = liRefs.current[s.id]
                  if (el) el.draggable = true
                }}
              >
                <DotsSixVertical size={18} weight="regular" />
              </span>
              <button
                type="button"
                onClick={() => move(s.id, -1)}
                disabled={i === 0}
                // Names the slide it moves. There is one pair of these per slide, so a
                // bare "Move slide up" is six identical buttons to a screen reader.
                aria-label={`Move slide ${i + 1} up`}
                title="Move up"
                className="grid size-11 shrink-0 place-items-center rounded-pill text-faint transition-colors hover:text-ink disabled:opacity-25"
              >
                <CaretUp size={16} weight="regular" />
              </button>
              <button
                type="button"
                onClick={() => move(s.id, 1)}
                disabled={i === ordered.length - 1}
                aria-label={`Move slide ${i + 1} down`}
                title="Move down"
                className="grid size-11 shrink-0 place-items-center rounded-pill text-faint transition-colors hover:text-ink disabled:opacity-25"
              >
                <CaretDown size={16} weight="regular" />
              </button>
              {/* The card's heading. The number and the type were already on screen as two
                  loose spans; making them the h2 gives the editor the document outline it
                  had none of, at no visual cost. "Slide" is only for the announcement — the
                  column of numerals reads as slide numbers on screen. */}
              {/* The sr-only pieces are separators. Without them the accessible name
                  concatenates to "Slide 1Quiz question" — flex `gap` is not a text node. */}
              <h2 className="ml-2 flex items-baseline gap-3">
                <span className="sr-only">Slide </span>
                <span className="tabular text-sm text-dim">{i + 1}</span>
                <span className="sr-only">, </span>
                <span className={capCls}>{typeLabel}</span>
              </h2>
              <span className="ml-auto">
                <DeleteButton
                  action={deleteSlideAction.bind(null, deck.id, s.id)}
                  confirmText="Delete this slide?"
                  name={slideName}
                  className={btn('danger', 'sm')}
                />
              </span>
            </div>
            <SlideCard deckId={deck.id} slide={s} name={slideName} />
          </li>
          )
        })}
      </ul>

      {ordered.length === 0 && (
        <p className="mt-8 text-center text-dim">
          No slides yet. Add one below, or generate a deck from a document.
        </p>
      )}

      {/* One button per slide type — driven off SLIDE_TYPES so adding a type doesn't need a
          matching edit here. */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {SLIDE_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() =>
              startTransition(() => run(addSlideAction(deck.id, t), 'Could not add a slide.'))
            }
            className="flex items-center justify-center gap-2 rounded-plate border border-dashed border-rule-strong py-4 text-sm font-semibold text-dim transition-colors hover:border-pen hover:bg-pen-wash hover:text-pen-ink"
          >
            <Plus size={16} weight="regular" />
            Add {SLIDE_TYPE_LABEL[t].toLowerCase()}
          </button>
        ))}
      </div>
    </div>
  )
}
