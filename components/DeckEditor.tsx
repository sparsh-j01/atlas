'use client'

import { CaretDown, CaretUp, DotsSixVertical, Plus } from '@phosphor-icons/react/ssr'
import { useOptimistic, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { SlideCard, type EditorSlide } from '@/components/SlideCard'
import { DeleteButton } from '@/components/DeleteButton'
import { btn, capCls, inputCls, panelCls } from '@/components/ui'
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
  const [, startTransition] = useTransition()

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
      <Link href="/dashboard" className="text-sm text-dim transition-colors hover:text-ink">
        Back to your decks
      </Link>

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
          ready ? 'border-correct/40' : ''
        }`}
      >
        <span
          aria-hidden
          className={`h-2 w-2 shrink-0 rounded-full ${ready ? 'bg-correct' : 'bg-faint'}`}
        />
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
        {ordered.map((s, i) => (
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
              <button
                type="button"
                aria-label="Drag to reorder"
                title="Drag to reorder"
                className="cursor-grab rounded-plate p-1.5 text-faint transition-colors hover:text-ink"
                onMouseDown={() => {
                  const el = liRefs.current[s.id]
                  if (el) el.draggable = true
                }}
              >
                <DotsSixVertical size={18} weight="regular" />
              </button>
              <button
                type="button"
                onClick={() => move(s.id, -1)}
                disabled={i === 0}
                aria-label="Move slide up"
                title="Move up"
                className="rounded-plate p-1.5 text-faint transition-colors hover:text-ink disabled:opacity-25"
              >
                <CaretUp size={16} weight="regular" />
              </button>
              <button
                type="button"
                onClick={() => move(s.id, 1)}
                disabled={i === ordered.length - 1}
                aria-label="Move slide down"
                title="Move down"
                className="rounded-plate p-1.5 text-faint transition-colors hover:text-ink disabled:opacity-25"
              >
                <CaretDown size={16} weight="regular" />
              </button>
              <span className="ml-2 font-data text-sm text-dim">{i + 1}</span>
              <span className={`${capCls} ml-3`}>
                {isSlideType(s.type) ? SLIDE_TYPE_LABEL[s.type] : s.type}
              </span>
              <span className="ml-auto">
                <DeleteButton
                  action={deleteSlideAction.bind(null, deck.id, s.id)}
                  confirmText="Delete this slide?"
                  className={btn('danger', 'sm')}
                />
              </span>
            </div>
            <SlideCard deckId={deck.id} slide={s} />
          </li>
        ))}
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
            className="flex items-center justify-center gap-2 rounded-plate border border-dashed border-rule-strong py-4 text-sm font-semibold text-dim transition-colors hover:border-lamp hover:bg-lamp/5 hover:text-lamp"
          >
            <Plus size={16} weight="regular" />
            Add {SLIDE_TYPE_LABEL[t].toLowerCase()}
          </button>
        ))}
      </div>
    </div>
  )
}
