import type { Viewport } from 'next'

// Metadata only. The play page is a client component (it holds the realtime connection), so
// its title has to be set by a server file — this layout exists for that and adds no markup.
export const metadata = { title: 'Play' }

export const viewport: Viewport = {
  // The room's ground, overriding the root layout's cream. A phone is on the join form for a
  // few seconds and inside .stage for the rest of the session, so the browser chrome matches
  // the room rather than the form. Without this, Android Chrome paints a light bar directly
  // above a #111 screen — the one place the dark surface visibly stops.
  themeColor: '#111111',
  // Scoped to this route, not the root: `cover` extends the layout viewport behind the notch
  // and the home indicator, which only an edge-anchored full-screen layout wants. It is also
  // what makes env(safe-area-inset-*) resolve to anything but 0, so the `.safe` utility on
  // the question screen is inert without it. The answer tiles are bottom-anchored into
  // exactly that inset — they measured to within 20px of the bottom edge on a 390×844 phone.
  viewportFit: 'cover',
}

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return children
}
