import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { signOutAction } from '@/lib/actions'
import { SiteHeader } from '@/components/SiteHeader'
import { btn } from '@/components/ui'

// Guards the whole creator area (middleware also gates, but a server component/action must
// never trust the middleware alone). requireUser redirects to /login when signed out.
export default async function CreatorLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser()
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader href="/dashboard">
        <div className="flex items-center gap-2 sm:gap-4">
          {/* Two destinations, so the creator area needs actual navigation rather than the
              logo plus a sign-out. Kept as ghost links so the header stays chrome — the pen
              belongs to what is live, and neither of these is (docs/design.md §3). */}
          {/* Hidden on a phone, where the wordmark beside it already links to /dashboard
              and the row has no width to spare. Results has no such duplicate, so it
              stays at every width. */}
          <Link href="/dashboard" className={`${btn('ghost', 'sm')} hidden sm:inline-flex`}>
            Decks
          </Link>
          <Link href="/results" className={btn('ghost', 'sm')}>
            Results
          </Link>
          <span className="hidden max-w-[22ch] truncate text-sm text-dim lg:block">
            {user.email}
          </span>
          <form action={signOutAction}>
            <button className={btn('ghost', 'sm')}>Sign out</button>
          </form>
        </div>
      </SiteHeader>
      {/* A <main>, not a <div>: this is the creator area's only content landmark and the
          header's skip link targets it. */}
      <main id="main" className="flex-1">
        {children}
      </main>
    </div>
  )
}
