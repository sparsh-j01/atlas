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

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg' | 'xl'

// Primary is ink on paper, not the gold accent. The accent is reserved for
// things that are live (room code, countdown, drain bar); spending it on every
// button would leave nothing to mark the one state that matters.
const VARIANT: Record<Variant, string> = {
  primary: 'bg-ink text-ground hover:bg-ink/88 shadow-lift',
  secondary: 'border border-rule bg-raised text-ink hover:border-rule-strong hover:bg-overlay',
  ghost: 'text-dim hover:text-ink hover:bg-overlay',
  danger: 'text-wrong hover:bg-wrong/8',
}

// Deliberately small. Oversized buttons are the loudest tell of a generated
// landing page; the reference sets its primary CTA at 15px/26px and it still
// reads as the most important thing on the screen because nothing competes.
const SIZE: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-[13px]',
  md: 'px-5 py-2.5 text-sm',
  lg: 'px-6 py-3 text-[15px]',
  xl: 'px-7 py-3.5 text-[15px]',
}

export function btn(variant: Variant = 'primary', size: Size = 'md') {
  return [
    'inline-flex items-center justify-center gap-2 rounded-pill font-medium whitespace-nowrap',
    'transition-all duration-150 active:translate-y-px',
    'disabled:pointer-events-none disabled:opacity-40',
    VARIANT[variant],
    SIZE[size],
  ].join(' ')
}

export const inputCls =
  'w-full rounded-pill border border-rule bg-raised px-3.5 py-2.5 text-ink transition-colors ' +
  'hover:border-rule-strong focus:border-ink focus:outline-none'

/** Flat bordered surface. Use where a card sits inside other content. */
export const panelCls = 'rounded-plate border border-rule bg-raised'

/** Lifted surface. Use where a card should read as sitting on top of the paper. */
export const cardCls = 'rounded-plate border border-rule bg-raised shadow-lift'

/** Small uppercase caption. Used for field labels and column headers, not as a decorative eyebrow. */
export const capCls = 'text-[11px] font-medium uppercase tracking-[0.16em] text-faint'

/** Inline text link that ends in an arrow. The reference's quiet secondary CTA. */
export const arrowLinkCls =
  'group inline-flex items-center gap-1.5 text-[15px] text-ink transition-colors hover:text-dim'
