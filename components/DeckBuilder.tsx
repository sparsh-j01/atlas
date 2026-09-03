'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { DIFFICULTIES } from '@/lib/ai/blueprint'
import { ACCEPT_ATTRIBUTE } from '@/lib/ingest/formats'
import { btn, capCls, inputCls, panelCls } from '@/components/ui'

// Both front doors in one place. A document deck and a topic deck differ only in where the
// questions come from, so the count / difficulty / polls controls are shared and only the
// source panel swaps. The two POST targets are different routes, but the response shape and
// the partial-result handling are identical.

const MIN_SLIDES = 3
const MAX_SLIDES = 20
const MAX_MB = 25

// Honest indeterminate progress: generation is one request that takes tens of seconds, so
// the messages cycle on a timer and never claim more precision than we have.
const STAGES = ['Outlining the deck', 'Writing questions', 'Checking every answer', 'Almost there']

// One line per pipeline state, so the uploader sees what is actually happening rather than
// a spinner. The names are the server's; the sentences are not.
const INGEST_STATUS: Record<string, string> = {
  uploaded: 'Reading the document',
  ocr: 'Reading text in the images',
  structuring: 'Working out the structure',
  chunking: 'Splitting it into passages',
  embedding: 'Indexing passages',
  ready: 'Ready',
}

type Coverage = { totalPages: number; readPages: number; message: string }
type Doc = {
  id: string
  filename: string
  pageCount: number | null
  duplicate: boolean
  coverage?: Coverage
}
type Result = { deckId: string; made: number; asked: number; dropped: string[] }

export function DeckBuilder() {
  const router = useRouter()
  const [mode, setMode] = useState<'document' | 'topic'>('document')

  const [topic, setTopic] = useState('')
  const [doc, setDoc] = useState<Doc | null>(null)
  const [ingest, setIngest] = useState<string | null>(null)

  const [slideCount, setSlideCount] = useState(8)
  const [difficulty, setDifficulty] = useState('medium')
  const [includePolls, setIncludePolls] = useState(true)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [partial, setPartial] = useState<Result | null>(null)
  const [stage, setStage] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!busy) return
    const id = setInterval(() => setStage((s) => s + 1), 8000)
    return () => clearInterval(id)
  }, [busy])

  /** Upload, then drive the resumable pipeline to `ready` by re-POSTing while it pauses. */
  async function upload(file: File) {
    setError(null)
    setDoc(null)
    setIngest('Uploading')
    try {
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/decks/ingest', { method: 'POST', body: form })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.documentId) {
        setError(data?.error ?? `Upload failed (${res.status}).`)
        setIngest(null)
        return
      }

      // The processor works in stages against a time budget and hands control back when it
      // runs out. Every stage commits its progress, so re-POSTing continues rather than
      // restarting. The loop is bounded so a stuck document cannot spin forever.
      setIngest('Reading the document')
      for (let i = 0; i < 40; i++) {
        const step = await fetch(`/api/documents/${data.documentId}/process`, { method: 'POST' })
        const s = await step.json().catch(() => null)
        if (!step.ok) {
          setError(s?.error ?? 'The document could not be processed.')
          setIngest(null)
          return
        }
        if (s.done) {
          setDoc({
            id: data.documentId,
            filename: file.name,
            pageCount: data.pageCount ?? null,
            duplicate: Boolean(data.duplicate),
            coverage: s.coverage,
          })
          setIngest(null)
          return
        }
        if (!s.paused) {
          // The server already turned its internal code into a sentence. Prefer that, and
          // never render a raw state name or anything that could carry a stack trace.
          setError(s?.error ?? 'The document could not be processed.')
          setIngest(null)
          return
        }
        setIngest(INGEST_STATUS[s.status] ?? 'Working on it')
      }
      setError('The document is taking longer than expected. Try uploading it again.')
      setIngest(null)
    } catch {
      setError('Network error during upload. Try again.')
      setIngest(null)
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError(null)
    setPartial(null)
    setStage(0)
    try {
      const fromDoc = mode === 'document'
      const res = await fetch(fromDoc ? '/api/decks/generate-pdf' : '/api/decks/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          fromDoc
            ? { documentId: doc?.id, slideCount, difficulty, includePolls }
            : { topic, slideCount, difficulty, includePolls },
        ),
      })
      // fetch() resolves on 4xx/5xx, so always read the body before trusting the shape.
      const data = (await res.json().catch(() => null)) as
        | { deckId?: string; error?: string; slides?: number; dropped?: string[] }
        | null
      if (!res.ok || !data?.deckId) {
        setError(data?.error ?? `Generation failed (${res.status}).`)
        setBusy(false)
        return
      }
      // A run can clear the survival floor and still drop slides. Navigating straight into
      // the editor would leave the creator counting questions to notice they asked for 8 and
      // got 6, so a partial result stops here and says so.
      if (data.dropped?.length) {
        setPartial({
          deckId: data.deckId,
          made: data.slides ?? 0,
          asked: slideCount,
          dropped: data.dropped,
        })
        setBusy(false)
        return
      }
      router.push(`/decks/${data.deckId}/edit`)
    } catch {
      setError('Network error. Try again.')
      setBusy(false)
    }
  }

  const ready = mode === 'document' ? Boolean(doc) : topic.trim().length > 0

  return (
    <form onSubmit={submit} className="mt-10 flex flex-col gap-8">
      {/* Source picker. Two real choices, so a segmented control rather than a dropdown. */}
      <div className="flex w-full gap-1 rounded-pill border border-rule bg-raised p-1 sm:w-fit">
        {(['document', 'topic'] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m)
              setError(null)
              setPartial(null)
            }}
            aria-pressed={mode === m}
            className={`flex-1 rounded-pill px-5 py-2.5 text-sm font-semibold transition-colors sm:flex-none ${
              mode === m ? 'bg-pen text-pen-on' : 'text-dim hover:text-ink'
            }`}
          >
            {m === 'document' ? 'From a document' : 'From a topic'}
          </button>
        ))}
      </div>

      {mode === 'document' ? (
        <DocumentPanel
          doc={doc}
          ingest={ingest}
          fileRef={fileRef}
          onPick={upload}
          onClear={() => {
            setDoc(null)
            if (fileRef.current) fileRef.current.value = ''
          }}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor="topic" className={capCls}>
            What should the deck be about?
          </label>
          <textarea
            id="topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={4}
            maxLength={400}
            placeholder="Photosynthesis for year 9 biology. Focus on the light-dependent reactions."
            className={`${inputCls} resize-y leading-relaxed`}
          />
          <p className="text-sm text-dim">
            Written from the model&apos;s own knowledge, not from your material. Upload a
            document if the questions need to follow your chapter.
          </p>
        </div>
      )}

      {/* Shared options. */}
      <div className="flex flex-wrap items-end gap-6 border-t border-rule pt-8">
        <div className="flex flex-col gap-2">
          <label htmlFor="count" className={capCls}>
            Slides
          </label>
          <input
            id="count"
            type="number"
            min={MIN_SLIDES}
            max={MAX_SLIDES}
            value={slideCount}
            onChange={(e) => setSlideCount(Number(e.target.value))}
            className={`${inputCls} w-24 tabular`}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="difficulty" className={capCls}>
            Difficulty
          </label>
          <select
            id="difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className={`${inputCls} w-36 capitalize`}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d} className="bg-raised capitalize">
                {d}
              </option>
            ))}
          </select>
        </div>

        <label className="flex cursor-pointer items-center gap-2.5 pb-3 text-sm">
          <input
            type="checkbox"
            checked={includePolls}
            onChange={(e) => setIncludePolls(e.target.checked)}
            className="h-4 w-4 accent-[var(--pen)]"
          />
          Mix in opinion polls
        </label>

        <button
          type="submit"
          disabled={busy || !ready || Boolean(ingest)}
          className={`${btn('primary', 'lg')} ml-auto`}
        >
          {busy ? 'Building' : 'Build the deck'}
        </button>
      </div>

      {busy && (
        <div className="flex flex-col gap-3">
          <p className="anim-breathe text-sm text-dim" aria-live="polite">
            {/* Clamped, not wrapped. `% length` sent a job past 32s back to "Outlining the
                deck", which is a claim about the server that is false by then — the whole
                point of naming stages instead of showing a spinner. It holds on the last. */}
            {STAGES[Math.min(stage, STAGES.length - 1)]}. This usually takes 30 to 60 seconds.
          </p>
          {/* Indeterminate on purpose: the job reports stages, not a percentage, and a
              fake percentage that stalls at 90 is worse than no number at all. */}
          <div
            aria-hidden
            className="h-0.5 w-full overflow-hidden rounded-pill bg-overlay motion-reduce:hidden"
          >
            <div className="h-full w-1/4 rounded-pill bg-pen [animation:sweep_1.4s_var(--ease-in-out)_infinite]" />
          </div>
        </div>
      )}

      {partial && (
        <div className={`${panelCls} border-pen/40 p-5`} role="status">
          <p className="font-semibold">
            Built {partial.made} of {partial.asked} slides.
          </p>
          <p className="mt-1 text-sm text-dim">
            {partial.dropped.length} did not pass the answer check and were left out rather
            than shipped unverified.
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm text-dim">
            {partial.dropped.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
          <Link href={`/decks/${partial.deckId}/edit`} className={`${btn('primary', 'md')} mt-5`}>
            Review the deck
          </Link>
        </div>
      )}

      {error && (
        <p role="alert" className="rounded-plate border border-wrong/40 bg-wrong-wash p-4 text-sm text-wrong">
          {error}
        </p>
      )}
    </form>
  )
}

function DocumentPanel({
  doc,
  ingest,
  fileRef,
  onPick,
  onClear,
}: {
  doc: Doc | null
  ingest: string | null
  fileRef: React.RefObject<HTMLInputElement | null>
  onPick: (f: File) => void
  onClear: () => void
}) {
  const [over, setOver] = useState(false)

  if (doc) {
    const kind = doc.filename.toLowerCase().endsWith('.pptx') ? 'PPTX' : 'PDF'
    const unit = kind === 'PPTX' ? 'slides' : 'pages'
    return (
      <div className={`${panelCls} flex flex-col gap-4 p-5`}>
        <div className="flex flex-wrap items-center gap-4">
          <span aria-hidden className="grid h-11 w-11 place-items-center rounded-pill bg-pen/15 tabular text-xs text-pen">
            {kind}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{doc.filename}</p>
            <p className="mt-0.5 text-sm text-dim">
              Indexed and ready
              {doc.pageCount ? `, ${doc.pageCount} ${unit}` : ''}
              {doc.duplicate ? '. You had already uploaded this one.' : '.'}
            </p>
          </div>
          <button type="button" onClick={onClear} className={btn('ghost', 'sm')}>
            Use a different file
          </button>
        </div>

        {/* What we could NOT read. Shown on success on purpose: a deck that is half
            screenshots ingests cleanly and generates from half the material, and this is
            the only place the teacher would ever find that out. */}
        {doc.coverage?.message ? (
          <p className="border-t border-rule pt-4 text-sm text-dim" role="status">
            {doc.coverage.message}. Questions come from the {doc.coverage.readPages} we could
            read.
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <label
        htmlFor="pdf"
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          const f = e.dataTransfer.files?.[0]
          if (f) onPick(f)
        }}
        className={`flex cursor-pointer flex-col items-center justify-center rounded-plate border border-dashed px-6 py-14 text-center transition-colors ${
          over ? 'border-pen bg-pen-wash' : 'border-rule-strong hover:border-ink hover:bg-overlay'
        }`}
      >
        {ingest ? (
          <>
            <span className="font-display text-xl">{ingest}</span>
            <span className="mt-2 text-sm text-dim">
              Reading the file and indexing it. Stay on this page.
            </span>
          </>
        ) : (
          <>
            <span className="font-display text-xl">Drop a lecture PDF or PowerPoint here</span>
            <span className="mt-2 text-sm text-dim">
              Or click to choose one. Up to {MAX_MB}MB. A PDF has to contain real text —
              scans of paper are rejected. A PowerPoint can have text in its images; we read
              those.
            </span>
          </>
        )}
      </label>
      <input
        ref={fileRef}
        id="pdf"
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        disabled={Boolean(ingest)}
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) onPick(f)
        }}
      />
    </div>
  )
}
