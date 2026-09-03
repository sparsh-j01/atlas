'use client'

import { MAX_OPTIONS, MIN_OPTIONS } from '@/lib/mcq'
import { CHART_KINDS, newPollOption } from '@/lib/poll'
import type { EditableSlide } from '@/lib/slides'
import {
  inputClass,
  OptionRows,
  SlideCardFooter,
  TimeLimitField,
  useSlideDraft,
} from '@/components/slide-fields'
import { capCls } from '@/components/ui'

type PollDraft = Extract<EditableSlide, { type: 'poll' }>

const CHART_LABEL: Record<(typeof CHART_KINDS)[number], string> = {
  bar: 'Bars',
  pie: 'Pie',
  donut: 'Donut',
}

/** The poll editor: an MCQ editor with the two scoring controls removed. No correct-answer
 *  radio, no points, no explanation — just the options, the window, and how to draw it. */
export function PollCard({
  deckId,
  slideId,
  initial,
  name,
}: {
  deckId: string
  slideId: string
  initial: PollDraft
  /** This card's position, e.g. "slide 2" — scopes every repeated control's name. */
  name: string
}) {
  const { draft: p, patch, patchNumber, save, pending, saved, errors, serverErrors } = useSlideDraft(
    deckId,
    slideId,
    initial,
  )

  return (
    <div className="flex flex-col gap-3">
      {/* Same reasoning as the MCQ prompt: a one-line input clipped the question mid-word. */}
      <textarea
        className={`${inputClass} w-full min-h-12 resize-y [field-sizing:content]`}
        rows={2}
        placeholder="What do you want to ask the room?"
        aria-label={`Poll question for ${name}`}
        value={p.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
      />

      <OptionRows
        name={name}
        options={p.options}
        min={MIN_OPTIONS}
        max={MAX_OPTIONS}
        onChangeText={(id, text) =>
          patch({ options: p.options.map((x) => (x.id === id ? { ...x, text } : x)) })
        }
        onRemove={(id) => patch({ options: p.options.filter((x) => x.id !== id) })}
        onAdd={() => patch({ options: [...p.options, newPollOption()] })}
      />

      <div className="flex flex-wrap items-center gap-4 text-sm">
        <TimeLimitField
          name={name}
          timeLimitMs={p.timeLimitMs}
          onChange={(raw) => patchNumber((n) => ({ timeLimitMs: n * 1000 }), raw)}
        />
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Chart type for {name}</legend>
          <span className={capCls}>Chart</span>
          {CHART_KINDS.map((k) => (
            <label key={k} className="flex items-center gap-1">
              <input
                type="radio"
                name={`chart-${slideId}`}
                checked={p.chart === k}
                onChange={() => patch({ chart: k })}
              />
              <span>{CHART_LABEL[k]}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <p className="text-sm text-dim">
        Unscored. Results appear on the screen live as the room votes.
      </p>

      <SlideCardFooter
        name={name}
        errors={errors}
        serverErrors={serverErrors}
        pending={pending}
        saved={saved}
        save={save}
      />
    </div>
  )
}
