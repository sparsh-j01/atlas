'use client'

import { useState, useTransition } from 'react'
import { saveSlideAction } from '@/lib/actions'
import { MAX_OPTIONS, MIN_OPTIONS, newOption, validateMcq, type EditableMcq, type McqConfig } from '@/lib/mcq'

const input =
  'w-full rounded-md border border-neutral-300 px-3 py-2 text-sm dark:border-neutral-700 dark:bg-neutral-900'

export function SlideCard({
  deckId,
  slide,
}: {
  deckId: string
  slide: { id: string; prompt: string; config: McqConfig }
}) {
  const [m, setM] = useState<EditableMcq>({
    prompt: slide.prompt,
    options: slide.config.options,
    timeLimitMs: slide.config.timeLimitMs,
    points: slide.config.points,
  })
  const [pending, startTransition] = useTransition()
  const [serverErrors, setServerErrors] = useState<string[]>([])
  const [saved, setSaved] = useState(false)

  const errors = validateMcq(m)

  function patch(p: Partial<EditableMcq>) {
    setM((prev) => ({ ...prev, ...p }))
    setSaved(false)
  }

  function save() {
    startTransition(async () => {
      try {
        const res = await saveSlideAction(deckId, slide.id, m)
        setServerErrors(res.errors)
        setSaved(res.errors.length === 0)
      } catch {
        setServerErrors(['Save failed — please retry.'])
        setSaved(false)
      }
    })
  }

  // Guard the numeric fields: skip non-finite parses so a bad value never round-trips
  // into the controlled input as "NaN".
  function patchNumber(patchFor: (n: number) => Partial<EditableMcq>, raw: string) {
    const n = Number(raw)
    if (Number.isFinite(n)) patch(patchFor(n))
  }

  return (
    <div className="flex flex-col gap-3">
      <input
        className={input}
        placeholder="Question prompt"
        value={m.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
      />

      <div className="flex flex-col gap-2">
        {m.options.map((o) => (
          <div key={o.id} className="flex items-center gap-2">
            <input
              type="radio"
              name={`correct-${slide.id}`}
              checked={o.is_correct}
              onChange={() => patch({ options: m.options.map((x) => ({ ...x, is_correct: x.id === o.id })) })}
              aria-label="Mark correct"
              title="Mark correct"
            />
            <input
              className={input}
              placeholder="Option text"
              value={o.text}
              onChange={(e) =>
                patch({ options: m.options.map((x) => (x.id === o.id ? { ...x, text: e.target.value } : x)) })
              }
            />
            <button
              type="button"
              onClick={() => patch({ options: m.options.filter((x) => x.id !== o.id) })}
              disabled={m.options.length <= MIN_OPTIONS}
              className="px-2 text-neutral-400 hover:text-red-600 disabled:opacity-30"
              aria-label="Remove option"
              title="Remove option"
            >
              ✕
            </button>
          </div>
        ))}
        {m.options.length < MAX_OPTIONS && (
          <button
            type="button"
            onClick={() => patch({ options: [...m.options, newOption(false)] })}
            className="self-start text-sm text-indigo-600 hover:underline"
          >
            + Add option
          </button>
        )}
      </div>

      <div className="flex flex-wrap gap-4 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Time (s)</span>
          <input
            type="number"
            min={5}
            max={300}
            className={`${input} w-20`}
            value={Math.round(m.timeLimitMs / 1000)}
            onChange={(e) => patchNumber((n) => ({ timeLimitMs: n * 1000 }), e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <span className="text-neutral-500">Points</span>
          <input
            type="number"
            min={0}
            max={5000}
            step={100}
            className={`${input} w-24`}
            value={m.points}
            onChange={(e) => patchNumber((n) => ({ points: n }), e.target.value)}
          />
        </label>
      </div>

      {(errors.length > 0 || serverErrors.length > 0) && (
        <ul className="text-sm text-amber-600">
          {[...new Set([...errors, ...serverErrors])].map((e) => (
            <li key={e}>• {e}</li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending || errors.length > 0}
          className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending ? 'Saving…' : 'Save slide'}
        </button>
        {saved && !pending && <span className="text-sm text-green-600">Saved</span>}
      </div>
    </div>
  )
}
