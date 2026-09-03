import { panelCls } from '@/components/ui'

/**
 * Shown while `getDeckWithSlides` runs. Same reasoning as the dashboard's: the editor is the
 * screen reached most often from a list click, and it did the whole round trip with the
 * previous page still on screen.
 *
 * Matches the editor's own column (max-w-3xl, px-6, py-12) and its stack: back link, title,
 * description, ready bar, slide cards.
 */
export default function EditDeckLoading() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-12" aria-busy>
      <p className="sr-only" role="status">
        Loading the deck
      </p>
      <div aria-hidden>
        <div className="h-4 w-36 rounded-pill bg-overlay" />
        <div className="mt-8 h-9 w-72 max-w-full rounded-tile bg-overlay" />
        <div className="mt-4 h-4 w-96 max-w-full rounded-pill bg-overlay" />
        <div className={`${panelCls} mt-6 flex h-[78px] items-center gap-4 px-5`}>
          <div className="h-2 w-2 rounded-full bg-overlay" />
          <div className="flex-1">
            <div className="h-4 w-24 rounded-pill bg-overlay" />
            <div className="mt-2 h-3.5 w-64 max-w-full rounded-pill bg-overlay" />
          </div>
        </div>
        <div className="mt-8 flex flex-col gap-4">
          {[0, 1].map((i) => (
            <div key={i} className={`${panelCls} h-64 p-5`}>
              <div className="h-4 w-28 rounded-pill bg-overlay" />
              <div className="mt-6 h-11 w-full rounded-pill bg-overlay" />
              <div className="mt-3 h-11 w-full rounded-pill bg-overlay" />
              <div className="mt-3 h-11 w-full rounded-pill bg-overlay" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
