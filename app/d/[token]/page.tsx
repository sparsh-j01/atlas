import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getSharedDeck } from '@/lib/decks'
import { getAuthUser } from '@/lib/auth'
import { copySharedDeckAction } from '@/lib/actions'
import { SiteHeader } from '@/components/SiteHeader'
import { SLIDE_TYPE_LABEL, isScored, type SlideType } from '@/lib/slides'
import { btn, capCls, panelCls } from '@/components/ui'

type Params = { params: Promise<{ token: string }> }

/**
 * A shared deck, read-only, no sign-in required.
 *
 * Outside the `(creator)` group on purpose: that layout calls requireUser and would bounce
 * every visitor to /login, which is the opposite of what a share link is for.
 *
 * The token in the URL is the entire credential, so the page must never be cached or
 * indexed. `noindex` keeps it out of search results; the deck's own creator can revoke it
 * from the editor at any time, after which this 404s like any unknown token.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Params) {
  const deck = await getSharedDeck((await params).token)
  return {
    title: deck ? deck.title : 'Deck not found',
    robots: { index: false, follow: false },
  }
}

export default async function SharedDeckPage({ params }: Params) {
  const { token } = await params
  const deck = await getSharedDeck(token)
  // Revoked, rotated, or never real — all the same 404. Distinguishing them would confirm
  // that a token was once valid, which is a fact worth nothing to a legitimate reader.
  if (!deck) notFound()

  // Signed in or not decides the footer, not the content: the questions are readable either
  // way, since that is what the link was sent for.
  const user = await getAuthUser()
  const scoredCount = deck.slides.filter((s) => isScored(s.type)).length

  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-6 py-14">
        <p className={capCls}>Shared deck</p>
        <h1 className="font-display mt-2 text-[44px] leading-none">{deck.title}</h1>
        {deck.description && (
          <p className="mt-4 max-w-[65ch] leading-relaxed text-dim">{deck.description}</p>
        )}
        <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-dim">
          <span className="tabular">
            {deck.slides.length} {deck.slides.length === 1 ? 'slide' : 'slides'}
          </span>
          {scoredCount > 0 && <span className="tabular">{scoredCount} scored</span>}
        </p>

        <div className="mt-8">
          {user ? (
            <form action={copySharedDeckAction.bind(null, token)}>
              <button className={btn('primary', 'lg')}>Save a copy to my decks</button>
            </form>
          ) : (
            <div className="flex flex-wrap items-center gap-4">
              <Link href="/login" className={btn('primary', 'lg')}>
                Sign in to save a copy
              </Link>
              <span className="text-sm text-dim">Free, and you keep your own copy to edit.</span>
            </div>
          )}
        </div>

        <ol className="mt-12 flex flex-col gap-4">
          {deck.slides.map((s, i) => {
            const scored = isScored(s.type)
            return (
              <li key={s.id} className={`${panelCls} px-5 py-5`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
                  <h2 className="font-display min-w-0 flex-1 text-[20px] leading-snug">
                    {/* Playfair, inherited: a slide number in a static list is a figure
                        at rest (docs/design.md §4), and .tabular would switch the family
                        mid-heading. */}
                    <span className="mr-2 text-dim">{i + 1}.</span>
                    {s.prompt}
                  </h2>
                  <span className={capCls}>
                    {SLIDE_TYPE_LABEL[s.type as SlideType] ?? 'Slide'}
                  </span>
                </div>
                <ul className="mt-4 flex flex-col gap-2">
                  {s.config.options.map((o) => {
                    const correct = scored && 'is_correct' in o && o.is_correct === true
                    return (
                      <li
                        key={o.id}
                        className={`flex items-start gap-3 text-sm leading-relaxed ${
                          correct ? 'font-semibold text-correct' : 'text-dim'
                        }`}
                      >
                        {/* The tick is the signal, the colour is the reinforcement — the
                            other way round fails docs/design.md §10 for anyone who cannot
                            separate the green. aria-hidden with a visually-hidden word
                            beside it, so it is read as a word rather than as punctuation. */}
                        <span aria-hidden className="w-4 shrink-0">
                          {correct ? '✓' : '·'}
                        </span>
                        <span>
                          {o.text}
                          {correct && <span className="sr-only"> (correct answer)</span>}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              </li>
            )
          })}
        </ol>

        <p className="mt-12 text-sm leading-relaxed text-dim">
          This is a read-only copy shared by its author. The correct answers are shown, so
          treat the link as something to send to colleagues rather than to a class.
        </p>
      </main>
    </div>
  )
}
