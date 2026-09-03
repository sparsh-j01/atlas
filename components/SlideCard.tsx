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
export function SlideCard({
  deckId,
  slide,
  name,
}: {
  deckId: string
  slide: EditorSlide
  /** This card's position, e.g. "slide 3". Scopes the accessible name of every repeated
   *  control inside it — see DeckEditor, which is where it is built. */
  name: string
}) {
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
    <PollCard deckId={deckId} slideId={slide.id} initial={draft} name={name} />
  ) : (
    <McqCard deckId={deckId} slideId={slide.id} initial={draft} name={name} />
  )
}

type McqDraft = Extract<EditableSlide, { type: 'quiz_mcq' }>

function McqCard({
  deckId,
  slideId,
  initial,
  name,
}: {
  deckId: string
  slideId: string
  initial: McqDraft
  name: string
}) {
  const { draft: m, patch, patchNumber, save, pending, saved, errors, serverErrors } = useSlideDraft(
    deckId,
    slideId,
    initial,
  )

  return (
    <div className="flex flex-col gap-3">
      {/* A textarea, not an input. The prompt is the longest and most important string on
          the card and a single line clipped it mid-word — while the shorter explanation
          below already got two rows. Grows with `field-sizing`, falls back to two rows. */}
      <textarea
        className={`${inputClass} w-full min-h-12 resize-y [field-sizing:content]`}
        rows={2}
        placeholder="Question prompt"
        aria-label={`Question prompt for ${name}`}
        value={m.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
      />

      <OptionRows
        name={name}
        options={m.options}
        min={MIN_OPTIONS}
        max={MAX_OPTIONS}
        onChangeText={(id, text) =>
          patch({ options: m.options.map((x) => (x.id === id ? { ...x, text } : x)) })
        }
        onRemove={(id) => patch({ options: m.options.filter((x) => x.id !== id) })}
        onAdd={() => patch({ options: [...m.options, newOption(false)] })}
        lead={(id) => {
          // The option's own text goes in the label, not just "Mark correct" — there is one
          // radio per option and they are otherwise indistinguishable to a screen reader.
          // Falls back to the position while the option is still empty, and carries the
          // slide too: two slides can hold options with the same text.
          const i = m.options.findIndex((x) => x.id === id)
          const optionName = m.options[i]?.text.trim() || `option ${i + 1}`
          return (
            // Wrapped in a 44px label rather than left bare. Every other radio in the editor
            // sits beside visible text and gets that text's target for free; this one is
            // named only by aria-label, so the target was the browser's own ~13px dot — the
            // most consequential click on the card, and the hardest to hit on a tablet.
            <label
              className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-pill transition-colors hover:bg-overlay"
              title="Mark correct"
            >
              <input
                type="radio"
                name={`correct-${slideId}`}
                checked={m.options[i]?.is_correct ?? false}
                onChange={() => patch({ options: m.options.map((x) => ({ ...x, is_correct: x.id === id })) })}
                aria-label={`Mark ${optionName} correct on ${name}`}
              />
            </label>
          )
        }}
      />

      <div className="flex flex-wrap gap-4 text-sm">
        <TimeLimitField
          name={name}
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
            className={`${inputClass} w-24 tabular`}
            aria-label={`Points for ${name}`}
            value={m.points}
            onChange={(e) => patchNumber((n) => ({ points: n }), e.target.value)}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-sm">
        <span className={capCls}>Explanation</span>
        <textarea
          className={`${inputClass} w-full min-h-16 resize-y`}
          maxLength={EXPLANATION_MAX}
          placeholder="Why this answer is right. Shown after the reveal."
          aria-label={`Explanation for ${name}`}
          value={m.explanation ?? ''}
          onChange={(e) => patch({ explanation: e.target.value })}
        />
      </label>

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
