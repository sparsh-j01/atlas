import type { SessionResults } from '@/lib/results'
import { buildPerformanceReport } from '@/lib/performance-report'
import { capCls, panelCls } from '@/components/ui'

export function TeacherImprovementReport({ results }: { results: SessionResults }) {
  const report = buildPerformanceReport(results)
  if (!report.students || !report.scoredQuestions) return null
  return <section className="mt-10" aria-labelledby="improvement-report">
    <h2 id="improvement-report" className="font-display text-3xl">Student improvement report</h2>
    <p className="mt-2 max-w-3xl text-sm leading-relaxed text-dim">Use this quiz to plan the next lecture. Percent correct includes unanswered questions. These observations describe this session.</p>
    <dl className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
      {[[`${report.masteryPercent}%`, 'Correct overall'], [`${report.attemptedAccuracy ?? '—'}${report.attemptedAccuracy === null ? '' : '%'}`, 'Correct among attempts'], [`${report.completionPercent}%`, 'Answer completion'], [report.needsSupport, 'Students below 60% correct']].map(([value, label]) => <div key={label} className={`${panelCls} p-5`}>
        <dt className="text-sm text-dim">{label}</dt><dd className="tabular mt-3 text-3xl font-semibold">{value}</dd>
      </div>)}
    </dl>
    <div className={`${panelCls} mt-5 p-5 sm:p-6`}>
      <h3 className="text-lg font-semibold">Performance patterns</h3>
      <ul className="mt-3 flex list-disc flex-col gap-3 pl-5 text-sm leading-relaxed text-dim">{report.patterns.map((p) => <li key={p}>{p}</li>)}</ul>
    </div>
    <div className="mt-8 grid gap-6 lg:grid-cols-2">
      <div>
        <h3 className="text-lg font-semibold">Priorities for the next lecture</h3>
        <div className="mt-4 flex flex-col gap-4">
          {report.priorities.map((p) => <article key={p.question.slideId} className={`${panelCls} p-5`}>
            <div className="flex items-baseline justify-between gap-3"><span className={capCls}>Question {p.question.number}</span><span className="tabular text-sm font-semibold">{p.successPercent}% correct</span></div>
            <h4 className="mt-2 font-semibold leading-snug">{p.question.prompt ?? 'Question text unavailable'}</h4>
            {p.commonWrong && <p className="mt-3 text-sm leading-relaxed text-dim">{p.commonWrong.count} {p.commonWrong.count === 1 ? 'student chose' : 'students chose'} “{p.commonWrong.text}”.</p>}
            {p.unanswered > 0 && <p className="mt-2 text-sm text-dim">{p.unanswered} left this question unanswered.</p>}
            <p className="mt-3 border-t border-rule pt-3 text-sm leading-relaxed">{p.suggestion}</p>
          </article>)}
          {!report.priorities.length && <p className="text-sm text-dim">Every scored question reached at least 80% correct. Build on this material with extension practice.</p>}
        </div>
      </div>
      <div>
        <h3 className="text-lg font-semibold">Material the class handled well</h3>
        <ul className="mt-4 flex flex-col gap-3">{report.strengths.map((p) => <li key={p.question.slideId} className={`${panelCls} p-5`}>
          <p className="text-sm font-semibold">Q{p.question.number} · {p.successPercent}% correct</p>
          <p className="mt-2 text-sm leading-relaxed text-dim">{p.question.prompt}</p>
        </li>)}</ul>
        {!report.strengths.length && <p className="mt-4 text-sm text-dim">No question reached 80% correct yet. Begin with the review priorities.</p>}
      </div>
    </div>
    <h3 className="mt-8 text-lg font-semibold">Individual student performance</h3>
    <p className="mt-2 text-sm text-dim">Expand a student to see their mistakes, unanswered questions, and suggested follow-up.</p>
    <div className="mt-4 flex flex-col gap-3">
      {report.individuals.map((p) => <details key={p.participantId} className={`${panelCls} p-5`}>
        <summary className="cursor-pointer text-sm font-semibold"><span>{p.nickname}</span><span className="ml-3 font-normal text-dim">{p.correctCount} / {report.scoredQuestions} correct · {p.masteryPercent}%</span></summary>
        <p className="mt-4 text-sm leading-relaxed">{p.recommendation}</p>
        {p.wrongQuestions.length > 0 && <ul className="mt-3 flex flex-col gap-2 text-sm text-dim">{p.wrongQuestions.map((q) => <li key={q.slideId}>
          <span className="font-semibold text-ink">Q{q.number}:</span> {q.prompt}<br />
          Chose “{p.bySlide[q.slideId].optionText ?? 'Removed option'}”; correct answer: “{q.options.find((o) => o.isCorrect)?.text ?? 'Unavailable'}”.
        </li>)}</ul>}
        {p.unansweredQuestions.length > 0 && <p className="mt-3 text-sm text-dim">Unanswered: questions {p.unansweredQuestions.map((q) => q.number).join(', ')}.</p>}
      </details>)}
    </div>
  </section>
}
