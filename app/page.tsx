import Link from 'next/link'

// Functional front door, not the designed landing page — that's M9. It exists so the app has
// a real entry point instead of the create-next-app scaffold: the two things anyone arriving
// here wants are to run a session or to join one.
export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-10 p-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-5xl font-bold tracking-tight">Atlas</h1>
        <p className="text-xl text-neutral-600 dark:text-neutral-400">
          Live in-class quizzes built from your own material. Students join from their phones
          with a room code — questions stay in sync, answers are scored as they land, and the
          leaderboard moves after every question.
        </p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <Link
          href="/play"
          className="flex-1 rounded-xl bg-indigo-600 px-6 py-5 text-center text-lg font-medium text-white hover:bg-indigo-500"
        >
          Join a session
          <span className="mt-1 block text-sm font-normal text-indigo-200">
            You need a 6-digit code. No account.
          </span>
        </Link>
        <Link
          href="/dashboard"
          className="flex-1 rounded-xl border border-neutral-300 px-6 py-5 text-center text-lg font-medium hover:border-neutral-400 dark:border-neutral-700"
        >
          Host a session
          <span className="mt-1 block text-sm font-normal text-neutral-500">
            Build a deck and present it. Sign-in required.
          </span>
        </Link>
      </div>
    </main>
  )
}
