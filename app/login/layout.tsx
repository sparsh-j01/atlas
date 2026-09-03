// Metadata only. The login page itself is a client component, so its title has to be set by
// a server file — this layout exists for that and adds no markup.
export const metadata = { title: 'Sign in' }

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return children
}
