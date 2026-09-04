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
  primary: 'bg-ink text-ground shadow-lift hover:-translate-y-0.5',
  secondary: 'border border-rule-strong bg-raised text-ink hover:bg-overlay hover:-translate-y-0.5',
  ghost: 'text-dim hover:text-ink hover:bg-overlay',
  danger: 'text-wrong hover:bg-wrong-wash',
  pen: 'bg-pen text-pen-on shadow-lift hover:-translate-y-0.5',
}

/**
 * The comp's playful hover tilt, opt-in per call site.
 *
 * It used to live in the `primary` and `pen` variants, which meant every one of them tilted
 * — docs/design.md §5 allows it in exactly one place, bans it on anything that repeats in a
 * list, and bans it outright inside `.stage`. It was firing on the dashboard's per-row
 * Present button and on Reveal and Start, which are on a projector in front of a class.
 */
export const tilt = 'hover:-rotate-1'

// The comp sets its primary CTA at 15px with a 999px radius and it still reads as the
// most important thing on the screen because nothing competes. Weight 700 is hers.
const SIZE: Record<Size, string> = {
  // `hit` on sm only: at 13px/py-1.5 the drawn button is ~28px tall, which clears WCAG
  // 2.5.8's 24px floor but not the 44px comfort target, and these are the controls a teacher
  // reaches for on a tablet (Sign out, Save slide, Delete slide). `.hit` grows the pointer
  // area with an invisible ::after and leaves the drawn size alone, so nothing moves.
  sm: 'hit px-3.5 py-1.5 text-[13px]',
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

/**
 * Everything a field shares except its radius and its width — the two properties a caller
 * legitimately needs to decide.
 *
 * Both are held out on purpose, and for the same reason. This repo has no `tailwind-merge`,
 * so class strings are concatenated raw and the CASCADE picks the winner, not the order you
 * wrote them in. `rounded-pill` in a shared string beats a caller's `rounded-plate`, and
 * `w-full` beat every `w-24` for months: the deck builder's Slides box rendered at 74px, the
 * width of the word "SLIDES", and Difficulty at 114px, the width of "DIFFICULTY". A shared
 * string must not carry a property its callers are expected to override — see
 * docs/failure-patterns.md #55.
 *
 * No `focus:outline-none` either. The base `:focus-visible` rule in globals.css is the focus
 * indicator for the whole app; a utility that removes the outline leaves a 1px border-colour
 * shift as the only cue, which fails WCAG 2.4.7 outright on the fields that render with a
 * transparent border (the deck title and description).
 */
const FIELD =
  'border border-rule-strong bg-raised px-4 py-2.5 text-ink transition-colors ' +
  'hover:border-dim focus:border-pen'

/** A single-line field. Pill, per docs/design.md §5. Callers add their own width. */
export const inputCls = `rounded-pill ${FIELD}`

/**
 * A multi-line field. `rounded-plate` (20px), never the pill.
 *
 * 999px on a box that is one line tall is a pill; on the deck builder's four-row topic box
 * it is a lozenge, and the curve cuts into the first line of text — the placeholder sat
 * ~8px from a sloping edge while the label above it and the help text below it both started
 * at the column's left edge, which is what read as broken alignment.
 */
export const textareaCls = `rounded-plate ${FIELD}`

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
 *
 * The `.cap` utility in globals.css, not a re-spelling of it. This used to be its own class
 * string at 11px while `.cap` (which the landing page uses) was 12px and docs/design.md §4
 * specifies 12px — one token, two sizes, drifting by screen. Every call site only ever
 * appends spacing, so pointing at the CSS costs nothing.
 */
export const capCls = 'cap'

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
