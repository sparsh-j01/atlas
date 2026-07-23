import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { signOutAction } from '@/lib/actions'

// Guards the whole creator area (middleware also gates, but a server component/action must
// never trust the middleware alone). requireUser redirects to /login when signed out.
export default async function CreatorLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
        <Link href="/dashboard" className="font-semibold">
          Quiz Live
        </Link>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-neutral-500">{user.email}</span>
          <form action={signOutAction}>
            <button className="rounded-md border border-neutral-300 px-3 py-1.5 hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900">
              Sign out
            </button>
          </form>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  )
}
