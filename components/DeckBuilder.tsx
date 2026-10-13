'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { X } from '@phosphor-icons/react/ssr'
import { useCallback, useEffect, useRef, useState } from 'react'
import { DIFFICULTIES } from '@/lib/ai/blueprint'
import { ACCEPT_ATTRIBUTE, FORMATS } from '@/lib/ingest/formats'
import { btn, editorButton, editorFieldCls, fieldLabelCls, panelCls, tileCls } from '@/components/ui'

// Both front doors in one place. A document deck and a topic deck differ only in where the
// questions come from, so the count / difficulty controls are shared and only the
// source panel swaps. The two POST targets are different routes, but the response shape and
// the partial-result handling are identical.

const MIN_SLIDES = 3
const MAX_SLIDES = 20
const MAX_MB = 25
/** Files per deck; the generation route enforces the same cap. */
const MAX_FILES = 5
/** The builder's file list survives leaving the page (processing carries on server-side), so
 *  coming back shows the same files with their live status instead of an empty box. */
const STORAGE_KEY = 'atlas:builder-files'
const POLL_MS = 2000
/** A stalled file (no worker, idle 30s) is resumed at most this often from this page. */
const RESUME_EVERY_MS = 30_000

// Honest indeterminate progress: generation is one request that takes tens of seconds, so
// the messages cycle on a timer and never claim more precision than we have.
const STAGES = ['Outlining the deck', 'Writing questions', 'Checking every answer', 'Almost there']

// One line per pipeline state, so the uploader sees what is actually happening rather than
// a spinner. The names are the server's; the sentences are not.
const INGEST_STATUS: Record<string, string> = {
  uploaded: 'Reading the file',
  ocr: 'Reading text in the slide images',
  structuring: 'Working out the sections',
  chunking: 'Splitting it into passages',
  embedding: 'Indexing passages',
}

type Coverage = { totalPages: number; readPages: number; message: string }
type FilePhase = 'preparing' | 'uploading' | 'checking' | 'processing' | 'ready' | 'failed'
type FileItem = {
  key: string
  name: string
  kind: 'PDF' | 'PPTX'
  phase: FilePhase
  documentId?: string
  /** Upload progress, 0-100. */
  percent?: number
  /** The server's pipeline state while processing. */
  status?: string
  /** Slide images read so far, during the ocr stage. */
  progress?: { done: number; total: number }
  pageCount?: number | null
  coverage?: Coverage
  duplicate?: boolean
  error?: string
  /** What "Try again" does: re-run the upload, or ask the server to retry processing. */
  retry?: 'upload' | 'process'
}
type Result = { deckId: string; made: number; asked: number; dropped: string[] }

/** The declared type, or the one the extension implies: some systems hand a .pptx over with
 *  an empty type, and the bucket's allowlist checks the type the upload carries. */
function mimeFor(file: File): string | null {
  if (FORMATS.some((f) => f.mimeType === file.type)) return file.type
  const ext = file.name.split('.').pop()?.toLowerCase()
  return FORMATS.find((f) => f.extension === ext)?.mimeType ?? null
}

async function sha256Hex(file: File): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Straight to Supabase Storage with the one-time upload URL; XHR because fetch reports no
 *  upload progress. The bytes never touch our server (Vercel caps request bodies at 4.5MB). */
function putToStorage(url: string, file: File, mime: string, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('x-upsert', 'false')
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`storage ${xhr.status}`)))
    xhr.onerror = () => reject(new Error('network'))
    const form = new FormData()
    form.append('cacheControl', '3600')
    form.append('', new File([file], file.name, { type: mime }))
    xhr.send(form)
  })
}

function readStoredFiles(): FileItem[] {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((r): FileItem[] =>
      r && typeof r.documentId === 'string' && typeof r.name === 'string'
        ? [{ key: r.documentId, documentId: r.documentId, name: r.name, kind: r.kind === 'PPTX' ? 'PPTX' : 'PDF', phase: 'processing' }]
        : [],
    ).slice(0, MAX_FILES)
  } catch {
    return [] // private mode or blocked storage: start empty, nothing breaks
  }
}

export function DeckBuilder() {
  const router = useRouter()
  const [mode, setMode] = useState<'document' | 'topic'>('document')

  const [topic, setTopic] = useState('')
  const [files, setFiles] = useState<FileItem[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const filesRef = useRef<FileItem[]>([])
  const picked = useRef(new Map<string, File>()) // the File behind each row, for "Try again"
  const resumedAt = useRef(new Map<string, number>())
  // State, not a ref: it must land in the SAME render as the restored files, or the save
  // effect runs once with the still-empty list and wipes what it was about to restore
  // (React dev runs effects twice, which made that wipe permanent).
  const [restored, setRestored] = useState(false)

  const [slideCount, setSlideCount] = useState(8)
  const [difficulty, setDifficulty] = useState('medium')

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

  const update = useCallback((key: string, patch: Partial<FileItem>) => {
    setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  }, [])

  // Restore once, after mount: localStorage does not exist during the server render.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time restore of browser-only state
    setFiles(readStoredFiles())
    setRestored(true)
  }, [])

  useEffect(() => {
    filesRef.current = files
    if (!restored) return
    try {
      const keep = files.filter((f) => f.documentId).map(({ documentId, name, kind }) => ({ documentId, name, kind }))
      localStorage.setItem(STORAGE_KEY, JSON.stringify(keep))
    } catch {
      // A per-browser convenience only; the files are safe on the server either way.
    }
  }, [files, restored])

  // Live status for every file the server is processing. GET only reads; a stalled file
  // (nobody holds it, idle 30s) gets one explicit resume, at most every RESUME_EVERY_MS.
  useEffect(() => {
    const timer = setInterval(async () => {
      for (const f of filesRef.current) {
        if (f.phase !== 'processing' || !f.documentId) continue
        try {
          const res = await fetch(`/api/documents/${f.documentId}/process`)
          if (res.status === 404) {
            update(f.key, { phase: 'failed', error: 'This file was deleted.', retry: undefined })
            continue
          }
          const s = await res.json().catch(() => null)
          if (!s || !res.ok) continue
          if (s.done) {
            update(f.key, { phase: 'ready', coverage: s.coverage, pageCount: s.pageCount, progress: undefined })
          } else if (typeof s.status === 'string' && s.status.startsWith('failed_')) {
            update(f.key, { phase: 'failed', error: s.error ?? 'Processing failed.', retry: 'process' })
          } else {
            update(f.key, { status: s.status, progress: s.progress, pageCount: s.pageCount })
            if (s.stalled && Date.now() - (resumedAt.current.get(f.key) ?? 0) > RESUME_EVERY_MS) {
              resumedAt.current.set(f.key, Date.now())
              void fetch(`/api/documents/${f.documentId}/process`, { method: 'POST' })
            }
          }
        } catch {
          // Offline for a moment: the next tick tries again.
        }
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [update])

  /** fingerprint → upload link → straight to Storage → confirm → server processes it. */
  async function uploadFile(key: string, file: File) {
    const fail = (message: string) => update(key, { phase: 'failed', error: message, retry: 'upload' })
    const mime = mimeFor(file)
    if (!mime) return update(key, { phase: 'failed', error: 'Only PDF or PowerPoint files can be used.', retry: undefined })
    if (file.size === 0) return update(key, { phase: 'failed', error: 'That file is empty.', retry: undefined })
    if (file.size > MAX_MB * 1024 * 1024) return update(key, { phase: 'failed', error: `That file is over ${MAX_MB}MB.`, retry: undefined })

    update(key, { phase: 'preparing', error: undefined, retry: undefined, percent: undefined })
    try {
      const hash = await sha256Hex(file)
      const res = await fetch('/api/decks/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, size: file.size, type: mime, hash }),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.documentId) return fail(data?.error ?? `Upload failed (${res.status}).`)
      if (filesRef.current.some((f) => f.key !== key && f.documentId === data.documentId)) {
        setFiles((list) => list.filter((f) => f.key !== key))
        setNotice(`${file.name} is already in this deck.`)
        return
      }
      update(key, { documentId: data.documentId })

      if (data.duplicate) {
        // Uploaded before: no bytes to send. A ready one is ready NOW (one read for its
        // coverage note); a failed one is retried; anything mid-way is left to the poll.
        if (data.status === 'ready') {
          const s = await fetch(`/api/documents/${data.documentId}/process`).then((r) => r.json()).catch(() => null)
          return update(key, { duplicate: true, phase: 'ready', pageCount: data.pageCount, coverage: s?.coverage })
        }
        update(key, { duplicate: true, phase: 'processing', status: data.status, pageCount: data.pageCount })
        if (String(data.status).startsWith('failed_')) void fetch(`/api/documents/${data.documentId}/process`, { method: 'POST' })
        return
      }
      if (data.upload?.signedUrl) {
        update(key, { phase: 'uploading', percent: 0 })
        await putToStorage(data.upload.signedUrl, file, mime, (percent) => update(key, { percent }))
      }

      update(key, { phase: 'checking' })
      const confirm = await fetch(`/api/documents/${data.documentId}/confirm`, { method: 'POST' })
      const checked = await confirm.json().catch(() => null)
      if (!confirm.ok) return fail(checked?.error ?? 'We could not check that file.')
      if (checked?.error) return update(key, { phase: 'failed', error: checked.error, retry: 'process' })
      update(key, { phase: 'processing', status: checked?.status, pageCount: checked?.pageCount })
    } catch {
      fail('The upload was interrupted. Check your connection and try again.')
    }
  }

  function addFiles(list: File[]) {
    setNotice(null)
    setError(null)
    const room = MAX_FILES - filesRef.current.length
    if (list.length > room)
      setNotice(room <= 0 ? `A deck can use up to ${MAX_FILES} files. Remove one to add another.` : `A deck can use up to ${MAX_FILES} files, so only the first ${room} were added.`)
    for (const file of list.slice(0, Math.max(0, room))) {
      const key = crypto.randomUUID()
      picked.current.set(key, file)
      const kind = mimeFor(file) === FORMATS.find((f) => f.id === 'pptx')?.mimeType ? 'PPTX' : 'PDF'
      setFiles((l) => [...l, { key, name: file.name, kind, phase: 'preparing' }])
      void uploadFile(key, file)
    }
    if (fileRef.current) fileRef.current.value = '' // so picking the same file again still fires
  }

  function retry(f: FileItem) {
    const file = picked.current.get(f.key)
    if (f.retry === 'upload' && file) return void uploadFile(f.key, file)
    if (f.retry === 'process' && f.documentId) {
      update(f.key, { phase: 'processing', error: undefined, retry: undefined })
      void fetch(`/api/documents/${f.documentId}/process`, { method: 'POST' }).then(async (res) => {
        if (!res.ok) update(f.key, { phase: 'failed', error: (await res.json().catch(() => null))?.error ?? 'Could not retry.', retry: 'process' })
      })
    }
  }

  /** Out of this deck only. The file stays in Uploaded files on the dashboard, where it can
   *  be deleted for good (eng review 2026-10-05, Issue 5A). */
  function remove(key: string) {
    picked.current.delete(key)
    setFiles((list) => list.filter((f) => f.key !== key))
    setNotice(null)
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
            ? { documentIds: files.map((f) => f.documentId), slideCount, difficulty }
            : { topic, slideCount, difficulty },
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

  const waiting = files.filter((f) => f.phase !== 'ready').length
  const ready = mode === 'document' ? files.length > 0 && waiting === 0 : topic.trim().length > 0
  // Said next to the disabled button, so it is never a mystery why it is grey.
  const buildHint =
    mode !== 'document' ? null
    : files.length === 0 ? 'Add a file to build from.'
    : files.some((f) => f.phase === 'failed') ? 'Remove or retry the file that failed.'
    : waiting > 0 ? `Waiting for ${waiting} ${waiting === 1 ? 'file' : 'files'} to finish. You can set the options meanwhile.`
    : null

  return (
    <form onSubmit={submit} className="mt-6 flex flex-col gap-6 rounded-lg border border-rule border-t-4 border-t-pen bg-raised p-5 sm:p-8">
      {/* Source picker. Two real choices, so a segmented control rather than a dropdown. */}
      <div className="flex gap-6 border-b border-rule">
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
            className={`border-b-2 px-1 pb-3 pt-1 text-sm font-semibold transition-colors ${
              mode === m ? 'border-pen text-pen-ink' : 'border-transparent text-dim hover:text-ink'
            }`}
          >
            {m === 'document' ? 'From a document' : 'From a topic'}
          </button>
        ))}
      </div>

      {mode === 'document' ? (
        <DocumentPanel files={files} notice={notice} fileRef={fileRef} onPick={addFiles} onRemove={remove} onRetry={retry} />
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor="topic" className={fieldLabelCls}>
            What should the deck be about?
          </label>
          <textarea
            id="topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
            rows={3}
            maxLength={400}
            // The placeholder is the only worked example of a good prompt anyone sees, so it
            // models the shape: subject, who it is for, then what to narrow to. Pitched at
            // the audience this is actually built for — a B.Tech CSE cohort — not a school
            // science class.
            placeholder="Deadlocks in operating systems, for a 4th-semester B.Tech CSE class. Focus on the Coffman conditions and the banker's algorithm."
            className={`${editorFieldCls} w-full resize-y`}
          />
          <p className="text-sm leading-relaxed text-dim">Add the subject, student level, and topics to cover. Use a document to follow your lecture material.</p>
        </div>
      )}

      {/* Shared options. */}
      <div className="grid grid-cols-2 gap-5 border-t border-rule pt-5">
        <div className="flex flex-col gap-2">
          <label htmlFor="count" className={fieldLabelCls}>
            Number of questions
          </label>
          <input
            id="count"
            type="number"
            min={MIN_SLIDES}
            max={MAX_SLIDES}
            value={slideCount}
            onChange={(e) => setSlideCount(Number(e.target.value))}
            className={`${editorFieldCls} w-full tabular`}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="difficulty" className={fieldLabelCls}>
            Difficulty
          </label>
          <select
            id="difficulty"
            value={difficulty}
            onChange={(e) => setDifficulty(e.target.value)}
            className={`${editorFieldCls} w-full capitalize`}
          >
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d} className="bg-raised capitalize">
                {d}
              </option>
            ))}
          </select>
        </div>

      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-rule pt-5">
        <p className="max-w-xs text-sm leading-relaxed text-dim">You can edit every question before starting a live class.</p>
        <button type="submit" disabled={busy || !ready} aria-describedby={buildHint ? 'build-hint' : undefined} className={editorButton('primary')}>
          {busy ? 'Building' : 'Build the deck'}
        </button>
        {buildHint && (
          <p id="build-hint" className="w-full text-sm text-dim" aria-live="polite">
            {buildHint}
          </p>
        )}
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
            {partial.dropped.length === 1 ? 'One topic' : `${partial.dropped.length} topics`} could not
            be turned into a checked question, even with spares, and were left out:
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

function fileStatus(f: FileItem): string {
  switch (f.phase) {
    case 'preparing':
      return 'Preparing'
    case 'uploading':
      return `Uploading, ${f.percent ?? 0}%`
    case 'checking':
      return 'Checking the file'
    case 'processing':
      if (f.status === 'ocr' && f.progress && f.progress.total > 0)
        return `Reading slide images, ${f.progress.done} of ${f.progress.total}`
      return f.duplicate && !f.status ? 'Uploaded before' : (INGEST_STATUS[f.status ?? ''] ?? 'Processing')
    case 'ready': {
      const unit = f.kind === 'PPTX' ? 'slide' : 'page'
      const count = f.pageCount ? `${f.pageCount} ${unit}${f.pageCount === 1 ? '' : 's'}` : ''
      return ['Ready', count, f.duplicate ? 'uploaded before' : ''].filter(Boolean).join(' · ')
    }
    case 'failed':
      return f.error ?? 'Something went wrong.'
  }
}

/** Real progress where we have it (upload bytes, images read), an honest sweep where we do not. */
function fileBar(f: FileItem): { value?: number } | null {
  if (f.phase === 'uploading') return { value: f.percent ?? 0 }
  if (f.phase === 'processing' && f.status === 'ocr' && f.progress && f.progress.total > 0)
    return { value: Math.round((f.progress.done / f.progress.total) * 100) }
  if (f.phase === 'preparing' || f.phase === 'checking' || f.phase === 'processing') return {}
  return null
}

function DocumentPanel({
  files,
  notice,
  fileRef,
  onPick,
  onRemove,
  onRetry,
}: {
  files: FileItem[]
  notice: string | null
  fileRef: React.RefObject<HTMLInputElement | null>
  onPick: (files: File[]) => void
  onRemove: (key: string) => void
  onRetry: (f: FileItem) => void
}) {
  const [over, setOver] = useState(false)
  const full = files.length >= MAX_FILES

  return (
    <div className="flex flex-col gap-3">
      {files.length > 0 && (
        <ul className="flex flex-col gap-2" aria-label="Files for this deck">
          {files.map((f) => {
            const bar = fileBar(f)
            const failed = f.phase === 'failed'
            return (
              <li key={f.key} className={`${tileCls} flex items-center gap-4 px-4 py-3 ${failed ? 'border-wrong/40' : ''}`}>
                <span
                  aria-hidden
                  className="grid h-10 w-12 shrink-0 place-items-center rounded-tile bg-overlay tabular text-xs font-bold text-dim"
                >
                  {f.kind}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold" title={f.name}>
                    {f.name}
                  </p>
                  {/* One live region per row, so each file's progress is announced as it moves. */}
                  <p className={`mt-0.5 text-sm ${failed ? 'text-wrong' : 'text-dim'}`} aria-live="polite">
                    {fileStatus(f)}
                  </p>
                  {bar && (
                    <div
                      className="mt-2 h-1 w-full overflow-hidden rounded-pill bg-overlay"
                      role="progressbar"
                      aria-label={`${f.name}: ${fileStatus(f)}`}
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={bar.value}
                    >
                      {bar.value === undefined ? (
                        <div className="h-full w-1/4 rounded-pill bg-pen motion-reduce:w-full motion-reduce:opacity-40 [animation:sweep_1.4s_var(--ease-in-out)_infinite] motion-reduce:[animation:none]" />
                      ) : (
                        <div className="h-full rounded-pill bg-pen transition-[width] duration-300" style={{ width: `${bar.value}%` }} />
                      )}
                    </div>
                  )}
                  {/* What could NOT be read. Shown on success on purpose: a deck that is half
                      screenshots ingests cleanly and generates from half the material, and this
                      is the only place the teacher would ever find that out. */}
                  {f.phase === 'ready' && f.coverage?.message && (
                    <p className="mt-1 text-xs leading-relaxed text-dim">{f.coverage.message}.</p>
                  )}
                </div>
                {failed && f.retry && (
                  <button type="button" onClick={() => onRetry(f)} className={btn('secondary', 'sm')}>
                    Try again <span className="sr-only">{f.name}</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onRemove(f.key)}
                  className="grid size-11 shrink-0 place-items-center rounded-pill text-dim transition-colors hover:bg-overlay hover:text-ink"
                  aria-label={`Remove ${f.name} from this deck`}
                  title="Remove from this deck (stays in your uploaded files)"
                >
                  <X size={18} weight="bold" aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {/* Before the label, not after it: `peer-*` compiles to a following-sibling selector,
          so the input has to precede the element that mirrors its focus. */}
      <input
        ref={fileRef}
        id="pdf"
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="peer sr-only"
        disabled={full}
        aria-describedby="pdf-help"
        onChange={(e) => onPick(Array.from(e.target.files ?? []))}
      />
      <label
        htmlFor="pdf"
        aria-disabled={full}
        onDragOver={(e) => {
          e.preventDefault()
          if (!full) setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          if (!full) onPick(Array.from(e.dataTransfer.files ?? []))
        }}
        // peer-focus-visible mirrors the real focus onto the label: the <input> is sr-only, so
        // keyboard focus lands on a clipped 1px box and the dropzone has to show it instead.
        className={`flex flex-col items-center justify-center rounded-md border border-dashed bg-ground text-center transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink ${
          files.length === 0 ? 'px-6 py-10' : 'px-6 py-6'
        } ${
          full
            ? 'cursor-not-allowed border-rule text-dim'
            : over
              ? 'cursor-pointer border-pen bg-pen-wash'
              : 'cursor-pointer border-rule-strong hover:border-ink hover:bg-overlay'
        }`}
      >
        {files.length === 0 ? (
          <span className="text-base font-semibold">Drop lecture PDFs or PowerPoints here</span>
        ) : (
          <span className="font-semibold">{full ? `That's the ${MAX_FILES}-file limit` : 'Add another file'}</span>
        )}
        <span id="pdf-help" className="mt-2 max-w-prose text-sm text-dim">
          {files.length === 0
            ? `Or click to choose. Up to ${MAX_FILES} files, ${MAX_MB}MB each. A PDF needs real text (scans of paper are rejected); text inside PowerPoint images is read for you.`
            : `${files.length} of ${MAX_FILES} files. Questions are drawn from all of them.`}
        </span>
      </label>

      {notice && (
        <p role="status" className="text-sm text-dim">
          {notice}
        </p>
      )}
      {files.some((f) => f.phase !== 'ready' && f.phase !== 'failed') && (
        <p className="text-sm text-dim">
          Files keep processing if you leave this page, and they will be here when you come back.
        </p>
      )}
    </div>
  )
}
