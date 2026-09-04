'use client'

import { useSyncExternalStore } from 'react'

// Nothing to subscribe to: the answer flips once, when React hydrates, and never again.
// Module-level constants so the identity is stable and useSyncExternalStore does not
// resubscribe on every render.
const noop = () => () => {}
const onClient = () => true
const onServer = () => false

/**
 * False during server rendering and the first (hydrating) client render, true afterwards.
 *
 * The point is reading something only the browser has — `window.location.origin`, the
 * reader's timezone — without either a hydration mismatch or a setState inside an effect.
 * The obvious `useState(false)` + `useEffect(() => setState(true))` does work, but it is a
 * cascading render that `react-hooks/set-state-in-effect` rejects, and React has a purpose
 * built hook for exactly this: useSyncExternalStore renders the server snapshot first, then
 * re-renders with the client one on its own.
 *
 * Use it to CHOOSE a value during render, not to trigger work. Anything that reads `window`
 * still has to sit behind the flag, because the server pass really does run without one.
 */
export function useIsClient(): boolean {
  return useSyncExternalStore(noop, onClient, onServer)
}
