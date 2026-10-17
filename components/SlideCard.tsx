'use client'

import { EXPLANATION_MAX, MAX_OPTIONS, MIN_OPTIONS, newOption } from '@/lib/mcq'
import { toEditable, type EditableSlide, type SlideConfig } from '@/lib/slides'
import {
  inputClass,
  textareaClass,
  OptionRows,
  SlideCardFooter,
  TimeLimitField,
  useSlideDraft,
  GrowingTextarea,
} from '@/components/slide-fields'
import { fieldLabelCls } from '@/components/ui'

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
  return <McqCard deckId={deckId} slideId={slide.id} initial={draft} name={name} />
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
  const { draft: m, patch, patchNumber, save, pending, saved, dirty, errors, serverErrors } = useSlideDraft(
    deckId,
    slideId,
    initial,
  )

  return (
    <div className="flex flex-col gap-6">
      <label className="flex flex-col gap-2">
      <span className="sr-only">Question</span>
      <GrowingTextarea
        className="w-full min-h-12 resize-none rounded-sm border-b border-rule bg-ground px-3 py-3 text-lg font-medium leading-relaxed focus:border-pen"
        rows={1}
        placeholder="Type your question"
        aria-label={`Question prompt for ${name}`}
        value={m.prompt}
        onChange={(e) => patch({ prompt: e.target.value })}
      />
      </label>

      <div className="flex flex-col gap-3">
      <p className={fieldLabelCls} id={`answers-${slideId}`}>
        Answer options <span className="ml-1 font-normal text-dim">· select the correct answer</span>
      </p>
      <OptionRows
        name={name}
        options={m.options}
        min={MIN_OPTIONS}
        max={MAX_OPTIONS}
        selectedId={m.options.find((o) => o.is_correct)?.id}
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
            // A full touch target makes selecting the answer key reliable on a tablet.
            <label
              className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors hover:bg-overlay"
              title="Mark as the correct answer"
            >
              <input
                type="radio"
                name={`correct-${slideId}`}
                className="size-4 accent-[var(--pen)]"
                checked={m.options[i]?.is_correct ?? false}
                onChange={() => patch({ options: m.options.map((x) => ({ ...x, is_correct: x.id === id })) })}
                aria-label={`Mark ${optionName} correct on ${name}`}
              />
            </label>
          )
        }}
      />
      </div>

      <div className="flex flex-wrap items-end gap-6 border-t border-rule pt-5 text-sm">
        <TimeLimitField
          name={name}
          timeLimitMs={m.timeLimitMs}
          onChange={(raw) => patchNumber((n) => ({ timeLimitMs: n * 1000 }), raw)}
        />
        <label className="flex flex-col gap-2">
          <span className={fieldLabelCls}>Points</span>
          <input
            type="number"
            min={0}
            max={5000}
            step={100}
            className={`${inputClass} w-28 tabular`}
            aria-label={`Points for ${name}`}
            value={m.points}
            onChange={(e) => patchNumber((n) => ({ points: n }), e.target.value)}
          />
        </label>
      </div>

      <details className="rounded-md border border-rule" open={Boolean(initial.explanation)}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">Answer explanation <span className="ml-1 font-normal text-dim">· shown after the quiz</span></summary>
      <label className="flex flex-col gap-2 border-t border-rule p-4 text-sm">
        <span className="sr-only">Answer explanation</span>
        <GrowingTextarea
          rows={2}
          className={`${textareaClass} w-full min-h-20 resize-none`}
          maxLength={EXPLANATION_MAX}
          placeholder="Explain why the answer is correct. Students see this after the quiz."
          aria-label={`Explanation for ${name}`}
          value={m.explanation ?? ''}
          onChange={(e) => patch({ explanation: e.target.value })}
        />
      </label>
      </details>

      <SlideCardFooter
        name={name}
        errors={errors}
        serverErrors={serverErrors}
        pending={pending}
        saved={saved}
        dirty={dirty}
        save={save}
      />
    </div>
  )
}
