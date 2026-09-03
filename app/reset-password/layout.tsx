// Metadata only. The page is a client component (it holds the form), so its title has to
// be set by a server file — this layout exists for that and adds no markup.
export const metadata = { title: 'New password' }

export default function ResetPasswordLayout({ children }: { children: React.ReactNode }) {
  return children
}
