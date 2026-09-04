import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getSessionResults } from '@/lib/sessions'
import { LocalTime } from '@/components/LocalTime'
import { SLIDE_TYPE_LABEL, type SlideType } from '@/lib/slides'
import type { QuestionResult } from '@/lib/results'
import { btn, capCls, panelCls } from '@/components/ui'

type Params = { params: Promise<{ sessionId: string }> }

export async function generateMetadata({ params }: Params) {
  const user = await requireUser()
  const page = await getSessionResults((await params).sessionId, user.id)
  return { title: page ? `${page.deckTitle ?? 'Deleted deck'} results` : 'Results' }
}

export default async function SessionResultsPage({ params }: Params) {
  const user = await requireUser()
  const { sessionId } = await params
  // Not their session, or it is still running. Both 404 rather than distinguishing —
  // "exists but not yours" is an existence oracle, and the id is a uuid nobody guesses.
  const page = await getSessionResults(sessionId, user.id)
  if (!page) notFound()

  const { results, deckTitle, deckId, session } = page
  const { questions, participants } = results
  const scored = questions.filter((q) => q.scored)
  // Share of scored answers that were right, across the whole session. The headline number:
  // it is the one figure that says whether the class understood the material.
  const totalScoredAnswers = scored.reduce((n, q) => n + q.answered, 0)
  const totalCorrect = scored.reduce((n, q) => n + q.correct, 0)
  const classAccuracy =
    totalScoredAnswers > 0 ? Math.round((totalCorrect / totalScoredAnswers) * 100) : null

  return (
    <div className="mx-auto max-w-6xl px-6 py-14">
      <nav className="mb-6 text-sm">
        <Link href="/results" className="text-dim underline-offset-4 hover:text-ink hover:underline">
          Results
        </Link>
      </nav>

      <div className="flex flex-wrap items-end justify-between gap-6">
        <div className="min-w-0">
          <h1 className="font-display text-[44px] leading-none">
            {deckTitle ?? 'Deleted deck'}
          </h1>
          <p className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-dim">
            <LocalTime iso={(session.endedAt ?? session.createdAt).toISOString()} />
            <span className="tabular">
              {participants.length} {participants.length === 1 ? 'player' : 'players'}
            </span>
            <span className="tabular">
              {questions.length} {questions.length === 1 ? 'question' : 'questions'}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          {/* A plain link, not a fetch + blob: the browser's own download is one line, keeps
              the file name from Content-Disposition, and works with the keyboard and a
              long-press on a tablet without any of it being reimplemented. */}
          <a href={`/results/${session.id}/export`} className={btn('primary', 'lg')} download>
            Export CSV
          </a>
          {deckId && (
            <Link href={`/decks/${deckId}/edit`} className={btn('secondary', 'lg')}>
              Open deck
            </Link>
          )}
        </div>
      </div>

      {results.deckDeleted && (
        <p className={`${panelCls} mt-8 px-5 py-4 text-sm leading-relaxed text-dim`}>
          This deck has been deleted. The scores and the answer counts below are intact — they
          are the session&apos;s own record — but the question text and the option labels went
          with the deck, so answers are listed by the option they picked rather than by name.
        </p>
      )}

      {participants.length === 0 ? (
        <div className="mt-12 rounded-plate border border-rule bg-raised px-8 py-16 text-center shadow-lift">
          <h2 className="font-display text-[30px]">Nobody joined</h2>
          <p className="mx-auto mt-4 max-w-md leading-relaxed text-dim">
            This session ended with an empty room, so there is nothing to report.
          </p>
        </div>
      ) : (
        <>
          {classAccuracy !== null && (
            <p className="mt-10 text-dim">
              The room answered{' '}
              <span className="tabular font-semibold text-ink">{classAccuracy}%</span> of scored
              questions correctly, across{' '}
              <span className="tabular text-ink">{totalScoredAnswers}</span> answers.
            </p>
          )}

          <section className="mt-12">
            <h2 className="font-display text-[28px]">By question</h2>
            <ul className="mt-6 flex flex-col gap-4">
              {questions.map((q) => (
                <QuestionCard key={q.slideId} q={q} players={participants.length} />
              ))}
            </ul>
          </section>

          <section className="mt-16">
            <h2 className="font-display text-[28px]">By player</h2>
            <p className="mt-2 text-sm text-dim">
              Ranked by score, as the final leaderboard was. The CSV export has a column per
              question for every player.
            </p>
            {/* The one table in the app. A table because it IS tabular data with a header
                row, which is also what lets a screen reader announce "Score, 1800" instead
                of reading four unlabelled numbers. Scrolls in its own box rather than
                widening the page. */}
            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[34rem] border-collapse text-left">
                <thead>
                  <tr className="border-b border-rule-strong">
                    <th scope="col" className={`${capCls} py-3 pr-4`}>
                      Rank
                    </th>
                    <th scope="col" className={`${capCls} py-3 pr-4`}>
                      Player
                    </th>
                    <th scope="col" className={`${capCls} py-3 pr-4 text-right`}>
                      Score
                    </th>
                    <th scope="col" className={`${capCls} py-3 pr-4 text-right`}>
                      Answered
                    </th>
                    <th scope="col" className={`${capCls} py-3 text-right`}>
                      Correct
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {participants.map((p) => (
                    <tr key={p.participantId} className="border-b border-rule last:border-0">
                      <td className="tabular py-3 pr-4 text-dim">{p.rank}</td>
                      {/* break-words, not truncate: a nickname is up to 24 characters and
                          this is the column identifying a person. */}
                      <th scope="row" className="max-w-[22ch] break-words py-3 pr-4 font-semibold">
                        {p.nickname}
                      </th>
                      <td className="tabular py-3 pr-4 text-right">{p.score}</td>
                      <td className="tabular py-3 pr-4 text-right text-dim">
                        {p.answered} / {questions.length}
                      </td>
                      <td className="tabular py-3 text-right text-dim">
                        {scored.length > 0 ? `${p.correct} / ${scored.length}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/** One question's distribution. Server-rendered bars: this is a report being read at a desk,
 *  not the reveal, so there is no entrance animation and no client boundary. */
function QuestionCard({ q, players }: { q: QuestionResult; players: number }) {
  const pctCorrect = q.answered > 0 ? Math.round((q.correct / q.answered) * 100) : null
  return (
    <li className={`${panelCls} px-5 py-5`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <h3 className="font-display min-w-0 flex-1 text-[20px] leading-snug">
          {/* No .tabular: that utility repoints the family to DM Sans (globals.css says
              so, load-bearing), which would set the number in sans inside a Playfair
              heading. docs/design.md §4 puts a figure that sits still in Playfair — the
              rule is about per-tick jitter, and a printed report has none. */}
          <span className="mr-2 text-dim">{q.number}.</span>
          {q.prompt ?? <span className="text-dim italic">Slide removed since the session</span>}
        </h3>
        <span className={capCls}>
          {q.type ? SLIDE_TYPE_LABEL[q.type as SlideType] : 'Unknown'}
        </span>
      </div>

      <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-dim">
        <span className="tabular">
          {q.answered} of {players} answered
        </span>
        {q.scored && pctCorrect !== null && (
          <span className="tabular">{pctCorrect}% correct</span>
        )}
        {q.avgResponseMs !== null && (
          <span className="tabular">{(q.avgResponseMs / 1000).toFixed(1)}s average</span>
        )}
      </p>

      {q.options.length === 0 ? (
        <p className="mt-4 text-sm text-dim">
          The options went with the deleted slide, so only the total is left.
        </p>
      ) : (
        <ul className="mt-4 flex flex-col gap-2.5">
          {q.options.map((o) => {
            const pct = q.answered > 0 ? Math.round((o.count / q.answered) * 100) : 0
            return (
              <li key={o.id}>
                <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
                  <span className={o.isCorrect ? 'font-semibold text-correct' : undefined}>
                    {o.text || <span className="text-dim italic">Untitled option</span>}
                    {/* The word beside the colour, per docs/design.md §10. aria-hidden
                        because the bar's own label already ends in ", correct". */}
                    {o.isCorrect && (
                      <span aria-hidden className="ml-2 font-normal">
                        ✓ Correct
                      </span>
                    )}
                  </span>
                  <span className="tabular shrink-0 text-dim">
                    {o.count} / {pct}%
                  </span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-pill bg-overlay">
                  <div
                    className={`h-full rounded-pill ${o.isCorrect ? 'bg-correct' : 'bg-rule-strong'}`}
                    style={{ width: `${pct}%` }}
                    role="img"
                    aria-label={`${o.text || 'Untitled option'}: ${o.count} of ${q.answered} (${pct}%)${
                      o.isCorrect ? ', correct' : ''
                    }`}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {q.strayCount > 0 && (
        <p className="mt-3 text-sm text-dim">
          <span className="tabular">{q.strayCount}</span>{' '}
          {q.strayCount === 1 ? 'answer chose an option' : 'answers chose options'} that no
          longer exist. The slide was edited after this session ran, so they are counted in the
          total but have no bar.
        </p>
      )}
    </li>
  )
}
