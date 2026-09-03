import type { SanitizedSlide } from '@/lib/realtime/events'

const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F']

/**
 * The question as the room sees it: prompt at signage scale, one lettered tile per option.
 * Letters rather than colours because the phone shows the same letters, so a student matches
 * by glyph instead of by remembering which colour was which.
 *
 * Shared by the host console and the landing page preview. The landing page rendering the
 * real component is the point: a hand-built mock of this would drift the first time the
 * projector changes.
 */
export function ProjectorSlide({
  prompt,
  options,
  size = 'room',
}: {
  prompt: string
  options: SanitizedSlide['options']
  /** `room` is projector scale. `preview` is the same layout at a size that fits a page. */
  size?: 'room' | 'preview'
}) {
  const room = size === 'room'
  return (
    <div className="flex flex-col gap-8">
      <h2
        className={`font-display max-w-[22ch] leading-[1.1] ${
          room ? 'text-4xl sm:text-5xl lg:text-6xl' : 'text-2xl sm:text-3xl'
        }`}
      >
        {prompt}
      </h2>
      <ul className={`grid gap-4 sm:grid-cols-2 ${room ? '' : 'gap-3'}`}>
        {options.map((o, i) => (
          <li
            key={o.id}
            className={`flex items-center gap-4 rounded-plate border border-rule bg-raised ${
              room ? 'gap-5 px-6 py-5' : 'px-4 py-3.5'
            }`}
          >
            <span
              aria-hidden
              className={`tabular grid shrink-0 place-items-center rounded-pill bg-overlay text-dim ${
                room ? 'h-10 w-10 text-lg' : 'h-8 w-8 text-sm'
              }`}
            >
              {LETTERS[i] ?? i + 1}
            </span>
            <span className={`leading-snug ${room ? 'text-2xl' : 'text-base'}`}>{o.text}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
