import { tileCls } from '@/components/ui'

/**
 * Shown while `listDecks` runs. Without a loading.tsx there is no Suspense boundary here, so
 * a navigation into the dashboard sat on the previous screen with no feedback at all until
 * the query came back.
 *
 * Shaped like the real page (heading block, two action pills, a column of rows at the row
 * height the list actually renders) so the swap is a fill-in rather than a jump. Blocks, not
 * a spinner: docs/design.md's product register asks for skeletons, and a spinner in the
 * middle of content says "something is happening" where this says "your decks are coming".
 */
export default function DashboardLoading() {
  return (
    <div className="mx-auto max-w-6xl px-6 py-14" aria-busy>
      {/* One live region for the whole screen. The blocks below are aria-hidden — twelve
          announced "loading" placeholders is noise, and this is the sentence that matters. */}
      <p className="sr-only" role="status">
        Loading your decks
      </p>
      <div aria-hidden className="flex flex-wrap items-end justify-between gap-6">
        <div>
          <div className="h-11 w-64 rounded-tile bg-overlay" />
          <div className="mt-4 h-4 w-80 max-w-full rounded-pill bg-overlay" />
        </div>
        <div className="flex gap-3">
          <div className="h-12 w-32 rounded-pill bg-overlay" />
          <div className="h-12 w-36 rounded-pill bg-overlay" />
        </div>
      </div>
      <ul aria-hidden className="mt-12 flex flex-col gap-3">
        {[0, 1, 2].map((i) => (
          <li key={i} className={`${tileCls} flex h-[86px] items-center gap-4 px-5`}>
            <div className="flex-1">
              <div className="h-5 w-56 max-w-full rounded-pill bg-overlay" />
              <div className="mt-2.5 h-3.5 w-32 rounded-pill bg-overlay" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
