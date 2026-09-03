import Link from 'next/link'
import { btn } from '@/components/ui'

/** The app's 404. Without it, a mistyped URL got the framework's default page — its own
 *  typography, its own colours, nothing of Atlas. */
export default function NotFound() {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center gap-6 px-6 text-center"
    >
      <div>
        <h1 className="font-display text-[44px] leading-none">No page here</h1>
        <p className="mt-3 text-dim">
          The link may be out of date. If you were joining a class, the code goes on the join
          screen rather than in the address bar.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-3">
        <Link href="/play" className={btn('primary', 'lg')}>
          Join a room
        </Link>
        <Link href="/" className={btn('secondary', 'lg')}>
          Atlas home
        </Link>
      </div>
    </main>
  )
}
