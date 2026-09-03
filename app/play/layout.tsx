// Metadata only. The play page is a client component (it holds the realtime connection), so
// its title has to be set by a server file — this layout exists for that and adds no markup.
export const metadata = { title: 'Play' }

export default function PlayLayout({ children }: { children: React.ReactNode }) {
  return children
}
