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
        <div className="flex items-center gap-4">
          <span className="hidden max-w-[22ch] truncate text-sm text-dim sm:block">
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
