'use client'

import { EXPLANATION_MAX, MAX_OPTIONS, MIN_OPTIONS, newOption } from '@/lib/mcq'
import { toEditable, type EditableSlide, type SlideConfig } from '@/lib/slides'
import { PollCard } from '@/components/PollCard'
import {
  inputClass,
  OptionRows,
  SlideCardFooter,
  TimeLimitField,
  useSlideDraft,
} from '@/components/slide-fields'
import { capCls } from '@/components/ui'

export type EditorSlide = { id: string; type: string; prompt: string; config: SlideConfig }

/** Picks the editor for a slide's type. `toEditable` is the same stored→draft conversion the
 *  deck ready-gate uses, so a row whose `type` and `config` disagree is reported here rather
 *  than rendering a half-populated form over the wrong shape. */
export function SlideCard({ deckId, slide }: { deckId: string; slide: EditorSlide }) {
  const draft = toEditable(slide)
  if (!draft) {
    return (
      <p className="text-sm text-wrong">
        This slide is stored in a shape this editor doesn’t recognise ({slide.type}). Delete it
        and add a new one.
      </p>
    )
  }
  return draft.type === 'poll' ? (
    <PollCard deckId={deckId} slideId={slide.id} initial={draft} />
  ) : (
    <McqCard deckId={deckId} slideId={slide.id} initial={draft} />
  )
}

type McqDraft = Extract<EditableSlide, { type: 'quiz_mcq' }>

function McqCard({ deckId, slideId, initial }: { deckId: string; slideId: string; initial: McqDraft }) {
  const { draft: m, patch, patchNumber, save, pending, saved, errors, serverErrors } = useSlideDraft(
    deckId,
    slideId,
    initial,
  )

  return (
    <div className="flex flex-col gap-3">
      <input
        className={inputClass}
        placeholder="Question prompt"
        value={m.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
      />

      <OptionRows
        options={m.options}
        min={MIN_OPTIONS}
        max={MAX_OPTIONS}
        onChangeText={(id, text) =>
          patch({ options: m.options.map((x) => (x.id === id ? { ...x, text } : x)) })
        }
        onRemove={(id) => patch({ options: m.options.filter((x) => x.id !== id) })}
        onAdd={() => patch({ options: [...m.options, newOption(false)] })}
        lead={(id) => (
          <input
            type="radio"
            name={`correct-${slideId}`}
            checked={m.options.find((x) => x.id === id)?.is_correct ?? false}
            onChange={() => patch({ options: m.options.map((x) => ({ ...x, is_correct: x.id === id })) })}
            aria-label="Mark correct"
            title="Mark correct"
          />
        )}
      />

      <div className="flex flex-wrap gap-4 text-sm">
        <TimeLimitField
          timeLimitMs={m.timeLimitMs}
          onChange={(raw) => patchNumber((n) => ({ timeLimitMs: n * 1000 }), raw)}
        />
        <label className="flex items-center gap-2">
          <span className={capCls}>Points</span>
          <input
            type="number"
            min={0}
            max={5000}
            step={100}
            className={`${inputClass} w-24 font-data`}
            value={m.points}
            onChange={(e) => patchNumber((n) => ({ points: n }), e.target.value)}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className={capCls}>Explanation</span>
        <textarea
          className={`${inputClass} min-h-16 resize-y`}
          maxLength={EXPLANATION_MAX}
          placeholder="Why this answer is right. Shown after the reveal."
          value={m.explanation ?? ''}
          onChange={(e) => patch({ explanation: e.target.value })}
        />
      </label>

      <SlideCardFooter
        errors={errors}
        serverErrors={serverErrors}
        pending={pending}
        saved={saved}
        save={save}
      />
    </div>
  )
}
