import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { signOutAction } from '@/lib/actions'
import { btn } from '@/components/ui'

// Guards the whole creator area (middleware also gates, but a server component/action must
// never trust the middleware alone). requireUser redirects to /login when signed out.
export default async function CreatorLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-rule bg-ground/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-6">
          <Link href="/dashboard" className="font-display text-xl">
            Atlas
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden truncate text-sm text-dim sm:block">{user.email}</span>
            <form action={signOutAction}>
              <button className={btn('ghost', 'sm')}>Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  )
}
