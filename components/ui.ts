/**
 * Shared class strings for the Atlas UI.
 *
 * Plain strings rather than components on purpose: half the call sites are
 * <button>, half are next/link <Link>, and a couple are <label>. A wrapper
 * component would need `as` plumbing to serve all three and would stop being
 * usable from server components without a client boundary.
 *
 * Everything here is written in tokens, so the same class strings render
 * correctly on paper and inside a `.stage` (dark live room) subtree.
 */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'pen'
type Size = 'sm' | 'md' | 'lg' | 'xl'

// Primary is ink on paper, not the accent -- straight from the landing comp. The pen
// is reserved for things that are live (room code, countdown, drain bar); spending it
// on every button would leave nothing to mark the one state that matters. `pen` exists
// for the rare control that IS the live action (Reveal, Start).
const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-ground shadow-lift hover:-translate-y-0.5 hover:-rotate-1',
  secondary: 'border border-rule-strong bg-raised text-ink hover:bg-overlay hover:-translate-y-0.5',
  ghost: 'text-dim hover:text-ink hover:bg-overlay',
  danger: 'text-wrong hover:bg-wrong-wash',
  pen: 'bg-pen text-pen-on shadow-lift hover:-translate-y-0.5 hover:-rotate-1',
}

// The comp sets its primary CTA at 15px with a 999px radius and it still reads as the
// most important thing on the screen because nothing competes. Weight 700 is hers.
const SIZE: Record<Size, string> = {
  sm: 'px-3.5 py-1.5 text-[13px]',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-6 py-3 text-[15px]',
  xl: 'px-7 py-3.5 text-[15px]',
}

export function btn(variant: Variant = 'primary', size: Size = 'md') {
  return [
    'inline-flex items-center justify-center gap-2 rounded-pill font-bold whitespace-nowrap',
    // The tilt on hover is the comp's one playful move. Kept on the filled variants
    // only, and it costs nothing under prefers-reduced-motion (globals.css kills it).
    'transition-[transform,background-color,color,border-color] duration-150 active:translate-y-0',
    'disabled:pointer-events-none disabled:opacity-40',
    VARIANT[variant],
    SIZE[size],
  ].join(' ')
}

// No `focus:outline-none` here. The base `:focus-visible` rule in globals.css is the
// focus indicator for the whole app; a utility that removes the outline leaves a 1px
// border-colour shift as the only cue, which fails WCAG 2.4.7 outright on the fields
// that render with a transparent border (the deck title and description).
export const inputCls =
  'w-full rounded-pill border border-rule-strong bg-raised px-4 py-2.5 text-ink transition-colors ' +
  'hover:border-dim focus:border-pen'

/** Flat bordered surface. Use where a card sits inside other content. */
export const panelCls = 'rounded-plate border border-rule bg-raised'

/** Lifted surface. Use where a card should read as sitting on top of the paper. */
export const cardCls = 'rounded-plate border border-rule bg-raised shadow-lift'

/** A row in a list, or an answer option. The smallest of the three radii. */
export const tileCls = 'rounded-tile border border-rule bg-raised'

/**
 * Small uppercase caption for field labels and column headers, not a decorative
 * eyebrow. `text-dim`, never `text-faint`: --faint is a non-text token (3.31:1 on
 * cream) and these are labels people have to read.
 */
export const capCls = 'text-[11px] font-semibold uppercase tracking-[0.16em] text-dim'

/**
 * The deck-status dot. Filled `--pen` = ready, hollow `--faint` = draft.
 *
 * One definition because the two screens that draw it had drifted apart: the dashboard row
 * used the pen dot and the editor's ready bar used `bg-correct`, so a teacher moving between
 * them saw the same fact in two colours and two shapes. Pen is the correct one —
 * docs/design.md §3 reserves correct/wrong for graded answers after a reveal, and a draft
 * deck is not a wrong answer.
 */
export function statusDotCls(ready: boolean) {
  return `h-2 w-2 shrink-0 rounded-full ${ready ? 'bg-pen' : 'border border-faint'}`
}

/** The blue section eyebrow from the comp. Decorative label above a heading. */
export const eyebrowCls = 'text-[13px] font-bold uppercase tracking-[0.3em] text-pen-ink'

/** Inline text link that ends in an arrow. The comp's quiet secondary CTA. */
export const arrowLinkCls =
  'group inline-flex items-center gap-1.5 text-[15px] font-semibold text-ink transition-colors hover:text-pen-ink'
