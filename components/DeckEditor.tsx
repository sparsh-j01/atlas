'use client'

import { useOptimistic, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { SlideCard } from '@/components/SlideCard'
import { DeleteButton } from '@/components/DeleteButton'
import {
  addSlideAction,
  deleteSlideAction,
  reorderSlidesAction,
  setDeckStatusAction,
  updateDeckAction,
} from '@/lib/actions'
import type { McqConfig } from '@/lib/mcq'

type EditorSlide = { id: string; type: string; prompt: string; config: McqConfig }
type EditorDeck = { id: string; title: string; description: string | null; status: string }

const input = 'rounded-md border border-neutral-300 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900'

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
      run(reorderSlidesAction(deck.id, next), 'Could not save the new order — please retry.')
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

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link href="/dashboard" className="text-sm text-neutral-500 hover:underline">
        ← All decks
      </Link>

      <div className="mt-4 flex flex-col gap-3">
        <input
          className={`${input} text-xl font-semibold`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => run(updateDeckAction(deck.id, { title }), 'Could not save the title.')}
          placeholder="Deck title"
        />
        <textarea
          className={input}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() =>
            run(updateDeckAction(deck.id, { description: description || null }), 'Could not save the description.')
          }
          placeholder="Description (optional)"
          rows={2}
        />
        <div className="flex items-center gap-3">
          <span
            className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
              status === 'ready'
                ? 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                : 'bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300'
            }`}
          >
            {status}
          </span>
          <button
            type="button"
            onClick={toggleStatus}
            className="text-sm text-indigo-600 hover:underline"
          >
            {status === 'ready' ? 'Back to draft' : 'Mark ready'}
          </button>
          {statusError && <span className="text-sm text-amber-600">{statusError}</span>}
        </div>
      </div>

      {actionError && (
        <p role="alert" className="mt-4 text-sm text-amber-600">
          {actionError}
        </p>
      )}

      <ul className="mt-6 flex flex-col gap-4">
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
            className="rounded-xl border border-neutral-200 p-4 dark:border-neutral-800"
          >
            <div className="mb-3 flex items-center gap-2">
              <button
                type="button"
                aria-label="Drag to reorder"
                title="Drag to reorder"
                className="cursor-grab select-none px-1 text-neutral-400"
                onMouseDown={() => {
                  const el = liRefs.current[s.id]
                  if (el) el.draggable = true
                }}
              >
                ⠿
              </button>
              <button
                type="button"
                onClick={() => move(s.id, -1)}
                disabled={i === 0}
                aria-label="Move slide up"
                title="Move up"
                className="px-1 text-neutral-400 hover:text-neutral-700 disabled:opacity-30 dark:hover:text-neutral-200"
              >
                ↑
              </button>
              <button
                type="button"
                onClick={() => move(s.id, 1)}
                disabled={i === ordered.length - 1}
                aria-label="Move slide down"
                title="Move down"
                className="px-1 text-neutral-400 hover:text-neutral-700 disabled:opacity-30 dark:hover:text-neutral-200"
              >
                ↓
              </button>
              <span className="text-sm font-medium text-neutral-500">Slide {i + 1}</span>
              <span className="ml-auto">
                <DeleteButton
                  action={deleteSlideAction.bind(null, deck.id, s.id)}
                  confirmText="Delete this slide?"
                />
              </span>
            </div>
            <SlideCard deckId={deck.id} slide={s} />
          </li>
        ))}
      </ul>

      <button
        type="button"
        onClick={() => startTransition(() => run(addSlideAction(deck.id), 'Could not add a slide.'))}
        className="mt-4 w-full rounded-lg border border-dashed border-neutral-300 py-3 text-sm font-medium text-neutral-600 hover:border-indigo-400 hover:text-indigo-600 dark:border-neutral-700"
      >
        + Add MCQ slide
      </button>
    </div>
  )
}
