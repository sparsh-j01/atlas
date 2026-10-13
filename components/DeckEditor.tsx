'use client'

import { ArrowLeft, CaretDown, CaretUp, DotsSixVertical, Plus } from '@phosphor-icons/react/ssr'
import { useOptimistic, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { SlideCard, type EditorSlide } from '@/components/SlideCard'
import { GrowingTextarea, hasUnsavedSlides, useUnsavedSlidesWarning } from '@/components/slide-fields'
import { DeleteButton } from '@/components/DeleteButton'
import { ShareDeck } from '@/components/ShareDeck'
import { editorButton, statusDotCls } from '@/components/ui'
import {
  addSlideAction,
  deleteSlideAction,
  launchDeckAction,
  reorderSlidesAction,
  setDeckStatusAction,
  updateDeckAction,
} from '@/lib/actions'
import { isSlideType, SLIDE_TYPE_LABEL, SLIDE_TYPES, type SlideType } from '@/lib/slides'

type EditorDeck = {
  id: string
  title: string
  description: string | null
  status: string
  shareToken: string | null
}

const iconButton = 'grid size-11 shrink-0 place-items-center rounded-md text-dim transition-colors hover:bg-overlay hover:text-ink aria-disabled:opacity-30'

export function DeckEditor({ deck, slides, sources = {} }: { deck: EditorDeck; slides: EditorSlide[]; sources?: Record<string, string[]> }) {
  const [title, setTitle] = useState(deck.title)
  const [description, setDescription] = useState(deck.description ?? '')
  const [status, setStatus] = useState(deck.status)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [leaveWarned, setLeaveWarned] = useState(false)
  const [selectedId, setSelectedId] = useState(slides[0]?.id)
  const [pending, startTransition] = useTransition()
  useUnsavedSlidesWarning()

  const byId = new Map(slides.map((s) => [s.id, s]))
  const [ordered, reorderOptimistic] = useOptimistic(slides, (_prev, newOrder: string[]) =>
    newOrder.map((id) => byId.get(id)).filter((s): s is EditorSlide => Boolean(s)),
  )
  // Keep inactive cards mounted so navigating preserves every draft and leave warning.
  const activeId = ordered.some((s) => s.id === selectedId) ? selectedId : ordered[0]?.id
  const liRefs = useRef<Record<string, HTMLLIElement | null>>({})
  const dragId = useRef<string | null>(null)

  function run(p: Promise<unknown>, message: string) {
    p.then(() => setActionError(null)).catch(() => setActionError(message))
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

  function move(id: string, direction: -1 | 1) {
    const ids = ordered.map((s) => s.id)
    const i = ids.indexOf(id)
    const j = i + direction
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    persistOrder(ids)
  }

  function add(type: SlideType) {
    startTransition(async () => {
      try {
        const id = await addSlideAction(deck.id, type)
        setSelectedId(id)
        setActionError(null)
      } catch {
        setActionError('Could not add a question. Please retry.')
      }
    })
  }

  function toggleStatus() {
    startTransition(async () => {
      try {
        const next = status === 'ready' ? 'draft' : 'ready'
        const res = await setDeckStatusAction(deck.id, next)
        if (res.error) setStatusError(res.error)
        else {
          setStatus(next)
          setStatusError(null)
        }
      } catch {
        setStatusError('Could not update the deck status. Please retry.')
      }
    })
  }

  const ready = status === 'ready'

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-8 sm:py-8">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-5">
        <div className="flex flex-wrap items-center gap-4">
          <Link
            href="/dashboard"
            className="inline-flex min-h-11 items-center gap-2 text-sm text-dim transition-colors hover:text-ink"
            onNavigate={(e) => {
              if (leaveWarned || !hasUnsavedSlides()) return
              e.preventDefault()
              setLeaveWarned(true)
              setTimeout(() => setLeaveWarned(false), 6000)
            }}
          >
            <ArrowLeft size={16} aria-hidden /> Your decks
          </Link>
          <span className="flex items-center gap-2 border-l border-rule pl-4 text-sm text-dim">
            <span aria-hidden className={statusDotCls(ready)} /> {ready ? 'Ready to present' : 'Draft'}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={toggleStatus} disabled={pending} className={editorButton(ready ? 'ghost' : 'primary')}>
            {ready ? 'Back to draft' : 'Mark ready'}
          </button>
          {ready && (
            <form
              action={launchDeckAction.bind(null, deck.id)}
              onSubmit={(e) => {
                if (!hasUnsavedSlides()) return
                e.preventDefault()
                setStatusError('Save your question edits before starting the live class.')
              }}
            >
              <button className={editorButton('primary')}>Start live class</button>
            </form>
          )}
        </div>
      </div>
      {leaveWarned && <p role="alert" className="mt-3 text-sm text-wrong">A question has unsaved edits. Click again to leave without saving.</p>}
      {statusError && <p role="alert" className="mt-3 text-sm text-wrong">{statusError}</p>}
      {actionError && <p role="alert" className="mt-3 text-sm text-wrong">{actionError}</p>}
      <h1 className="sr-only">{title || 'Untitled deck'}</h1>

      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="min-w-0 lg:sticky lg:top-6">
          <div className="mb-3 flex items-center justify-between px-1">
            <h2 className="text-sm font-semibold">Questions</h2>
            <span className="tabular text-sm text-dim">{ordered.length}</span>
          </div>
          <nav aria-label="Deck questions" className="min-w-0">
            <ul className="flex gap-2 overflow-x-auto pb-2 lg:max-h-[60vh] lg:flex-col lg:overflow-y-auto">
              {ordered.map((s, i) => (
                <li
                  key={s.id}
                  ref={(el) => { liRefs.current[s.id] = el }}
                  onDragStart={() => { dragId.current = s.id }}
                  onDragEnd={() => {
                    const el = liRefs.current[s.id]
                    if (el) el.draggable = false
                    dragId.current = null
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => onDrop(s.id)}
                  className={`flex shrink-0 items-center rounded-md border lg:w-full ${activeId === s.id ? 'border-pen/40 bg-pen-wash' : 'border-transparent hover:bg-overlay'}`}
                >
                  <button
                    type="button"
                    aria-label={`Edit question ${i + 1}`}
                    aria-current={activeId === s.id ? 'true' : undefined}
                    onClick={() => setSelectedId(s.id)}
                    className="flex min-h-12 min-w-0 flex-1 items-start gap-3 p-3 text-left"
                  >
                    <span className={`tabular shrink-0 text-sm font-semibold ${activeId === s.id ? 'text-pen-ink' : 'text-dim'}`}>{i + 1}.</span>
                    <span className="hidden min-w-0 lg:block">
                      <span className="line-clamp-2 text-sm leading-5">{s.prompt || 'Untitled question'}</span>
                      <span className="mt-1 block text-xs text-dim">Multiple choice</span>
                    </span>
                  </button>
                  <span
                    aria-hidden
                    className="mr-1 hidden cursor-grab p-1 text-dim lg:block"
                    onMouseDown={() => {
                      const el = liRefs.current[s.id]
                      if (el) el.draggable = true
                    }}
                  >
                    <DotsSixVertical size={16} />
                  </span>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-2 flex flex-wrap gap-1 border-t border-rule pt-3 lg:flex-col">
            {SLIDE_TYPES.map((type) => (
              <button key={type} type="button" disabled={pending} onClick={() => add(type)} className={editorButton('ghost')}>
                <Plus size={16} aria-hidden /> Add {SLIDE_TYPE_LABEL[type].toLowerCase()}
              </button>
            ))}
          </div>
          <p className="mt-4 hidden px-1 text-xs leading-5 text-dim lg:block">Select a question to edit it. Save your changes before presenting.</p>
        </aside>

        <div className="min-w-0 space-y-4">
          <section aria-label="Deck details" className="rounded-lg border border-rule border-t-4 border-t-pen bg-raised p-5 sm:p-7">
            <input
              className="w-full rounded-sm border-b border-transparent bg-transparent py-1 text-2xl font-semibold tracking-tight hover:border-rule focus:border-pen sm:text-3xl"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => run(updateDeckAction(deck.id, { title }), 'Could not save the title.')}
              placeholder="Untitled deck"
              aria-label="Deck title"
            />
            <GrowingTextarea
              className="mt-2 w-full resize-none rounded-sm border-b border-transparent bg-transparent py-1 text-sm leading-relaxed hover:border-rule focus:border-pen"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => run(updateDeckAction(deck.id, { description: description || null }), 'Could not save the description.')}
              placeholder="Add a description for this deck"
              rows={1}
              aria-label="Deck description"
            />
          </section>

          {ordered.map((s, i) => {
            const slideName = `slide ${i + 1}`
            const typeLabel = isSlideType(s.type) ? SLIDE_TYPE_LABEL[s.type] : s.type
            return (
              <section key={s.id} hidden={activeId !== s.id} aria-label={`Question ${i + 1} editor`} className="rounded-lg border border-rule border-l-[3px] border-l-pen bg-raised p-5 sm:p-7">
                <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-rule pb-3">
                  <h3 className="flex items-center gap-3 text-sm">
                    <span className="font-semibold">Question {i + 1}</span>
                    <span className="rounded border border-rule bg-ground px-2 py-1 text-xs text-dim">{typeLabel}</span>
                  </h3>
                  <div className="flex flex-wrap items-center gap-1">
                    <button type="button" onClick={() => move(s.id, -1)} aria-disabled={i === 0} aria-label={`Move slide ${i + 1} up`} title="Move up" className={iconButton}>
                      <CaretUp size={16} aria-hidden />
                    </button>
                    <button type="button" onClick={() => move(s.id, 1)} aria-disabled={i === ordered.length - 1} aria-label={`Move slide ${i + 1} down`} title="Move down" className={iconButton}>
                      <CaretDown size={16} aria-hidden />
                    </button>
                    <DeleteButton action={deleteSlideAction.bind(null, deck.id, s.id)} confirmText="Delete this question?" name={slideName} className={editorButton('danger')} />
                  </div>
                </div>
                <SlideCard deckId={deck.id} slide={s} name={slideName} />
                {sources[s.id] && <p className="mt-3 text-xs text-dim">From {sources[s.id].join(' · ')}</p>}
              </section>
            )
          })}
          {ordered.length === 0 && <div className="rounded-lg border border-dashed border-rule-strong p-10 text-center text-sm text-dim">Add your first question using the question toolbar.</div>}

          <details className="rounded-lg border border-rule bg-raised">
            <summary className="cursor-pointer px-5 py-4 text-sm font-semibold">Share with another teacher</summary>
            <ShareDeck deckId={deck.id} initialToken={deck.shareToken} compact />
          </details>
        </div>
      </div>
    </div>
  )
}
