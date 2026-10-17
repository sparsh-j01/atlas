import type { ParticipantReview } from '@/lib/participant-review'
import { btn, capCls, panelCls } from '@/components/ui'

export function StudentReview({ review, onJoinAgain }: { review: ParticipantReview; onJoinAgain: () => void }) {
  return <main className="safe mx-auto w-full max-w-3xl px-5 py-10 sm:px-8">
    <div className="flex flex-wrap items-start justify-between gap-5">
      <div>
        <p className={capCls}>Quiz complete · {review.nickname}</p>
        <h1 className="font-display mt-3 text-4xl sm:text-5xl">Your answer review</h1>
        <p className="mt-3 text-dim">You finished #{review.rank} with {review.score} points.</p>
      </div>
      <button type="button" onClick={onJoinAgain} className={btn('secondary', 'md')}>Join another quiz</button>
    </div>
    <dl className="mt-8 grid grid-cols-3 gap-3 border-y border-rule py-5">
      {[[review.correct, 'Correct'], [review.wrong, 'Incorrect'], [review.unanswered, 'Unanswered']].map(([value, label]) => <div key={label}>
        <dd className="tabular text-3xl font-semibold">{value}</dd><dt className="mt-1 text-sm text-dim">{label}</dt>
      </div>)}
    </dl>
    <p className="mt-6 text-sm text-dim">Review the explanations for your mistakes. Expand any correct answer to read its explanation.</p>
    <ol className="mt-6 flex flex-col gap-5">
      {review.questions.map((q) => {
        const label = q.outcome === 'correct' ? 'Correct' : q.outcome === 'wrong' ? 'Incorrect' : 'Unanswered'
        const explanation = q.explanation ?? (q.options.find((o) => o.correct)
          ? `The correct answer is “${q.options.find((o) => o.correct)?.text}”. Your teacher has not added a further explanation.` : null)
        return <li key={q.slideId} className={`${panelCls} p-5 sm:p-6`}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className={capCls}>Question {q.number}</span>
            <span className={`text-sm font-semibold ${q.outcome === 'correct' ? 'text-correct' : q.outcome === 'wrong' ? 'text-wrong' : 'text-dim'}`}>{label}</span>
          </div>
          <h2 className="text-xl font-semibold leading-snug">{q.prompt}</h2>
          <ul className="mt-5 flex flex-col gap-2">
            {q.options.map((o) => <li key={o.id} className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border px-4 py-3 ${o.correct ? 'border-correct/40 bg-correct/10' : o.picked ? 'border-wrong/40 bg-wrong-wash' : 'border-rule'}`}>
              <span className="min-w-0 flex-1 break-words text-sm leading-relaxed">{o.text}</span>
              <span className="text-xs font-semibold">{o.correct && o.picked ? 'Your answer · correct' : o.correct ? 'Correct answer' : o.picked ? 'Your answer' : ''}</span>
            </li>)}
          </ul>
          {explanation && (q.outcome === 'correct' ? <details className="mt-4 rounded-xl border border-rule bg-ground p-4">
            <summary className="cursor-pointer text-sm font-semibold">Why this answer is correct</summary>
            <p className="mt-3 text-sm leading-relaxed text-dim">{explanation}</p>
          </details> : <div className="mt-4 rounded-xl border border-pen/30 bg-pen-wash p-4">
            <h3 className="text-sm font-semibold">{q.outcome === 'unanswered' ? 'What to review' : 'Why this answer is correct'}</h3>
            <p className="mt-2 text-sm leading-relaxed text-dim">{explanation}</p>
          </div>)}
        </li>
      })}
    </ol>
    {review.questions.length === 0 && <p className="mt-8 text-dim">The session ended before any questions were completed.</p>}
  </main>
}
