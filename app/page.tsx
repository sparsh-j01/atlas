import Link from 'next/link'
import { MarketingNav, SiteFooter, SiteHeader } from '@/components/SiteHeader'
import { avatarUrl } from '@/lib/avatars'
import { btn } from '@/components/ui'

// The mock tally in the hero. Percentages are illustrative, not a claim.
const answers = [
  { letter: 'A', text: 'Connect devices', percent: 34 },
  { letter: 'B', text: 'Deliver packets', percent: 72 },
  { letter: 'C', text: 'Encrypt traffic', percent: 21 },
  { letter: 'D', text: 'Translate domains', percent: 48 },
]

// Sequence, so the numbering carries real information: you cannot review before you
// generate, or play before you review.
const steps = [
  {
    n: '01',
    title: 'Bring your material',
    body: 'Upload a lecture PDF, or just describe the topic you are teaching.',
  },
  {
    n: '02',
    title: 'Atlas builds the deck',
    body: 'Questions are written from the passages in your document, and cite them.',
  },
  {
    n: '03',
    title: 'Review before anyone sees it',
    body: 'Edit anything. A deck cannot go live until you mark it ready.',
  },
  {
    n: '04',
    title: 'Play it live',
    body: 'Students join with a six-digit code. The room stays in sync as you go.',
  },
]

// Real questions about how the product works. Nothing here promises anything the
// product does not do -- no pricing, no integrations, no roadmap.
const faqs = [
  {
    q: 'Do students need an account?',
    a: 'No. They open the join page, type the six-digit code on your screen and pick a nickname. Nothing to install, nothing to sign up for, and no student data to look after.',
  },
  {
    q: 'What can I upload?',
    a: 'A text-based PDF: lecture slides, notes, a chapter. Atlas reads the passages and writes questions from them. Scanned or image-only PDFs are rejected rather than guessed at, because questions written from an unreadable document would be questions about nothing.',
  },
  {
    q: 'How many students can play at once?',
    a: 'The room is built for 100 or more on their own phones, with the leaderboard staying in sync. Everyone sees the same question at the same moment.',
  },
  {
    q: 'Can I change the questions before class?',
    a: 'You have to. A generated deck lands as a draft you edit, and it cannot host a session until you mark it ready. Nothing reaches a room you have not read first.',
  },
  {
    q: 'What if a student loses signal mid-question?',
    a: 'They rejoin with the same code and land back on the live question with their score intact. The room does not wait for them and nothing is lost.',
  },
  {
    q: 'What kinds of questions can it ask?',
    a: 'Multiple-choice questions, which are scored and ranked on the leaderboard, and polls, which show the room how it answered without a right answer.',
  },
]

export default function Home() {
  return (
    // .atlas-page stays the outer wrapper because its own `a` rules style the header's
    // links; the landmark is the content below the header, not the whole page.
    <div className="atlas-page">
      <SiteHeader wide>
        <MarketingNav />

        <div className="flex items-center gap-4 text-sm sm:gap-6">
          <Link href="/play" className="hover:underline">
            Join a class
          </Link>
          <Link href="/login" className={btn('secondary', 'md')}>
            Sign in
          </Link>
        </div>
      </SiteHeader>

      <main id="main">

      {/* HERO */}
      <section className="hero">
        <div className="hero-left">
          <p className="eyebrow mb-7">Live learning platform</p>

          <h1 className="hero-title">
            <span className="block">Turn your</span>
            <span className="block">lectures into</span>
            <span className="blue-text block">live games.</span>
          </h1>

          <span className="blue-scribble" aria-hidden>
            {'\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E'}
          </span>

          <p className="sticky-note">
            <strong>Your material.</strong>
            <br />
            Your questions.
            <br />
            Your classroom. <u>Live.</u>
          </p>

          <p className="hero-description">
            Upload a lecture and Atlas writes questions from what is actually in it. Your
            whole class plays together, on their own phones, in real time.
          </p>

          <div className="hero-buttons">
            <Link href="/login?mode=signup" className={btn('primary', 'xl')}>
              Create a classroom
            </Link>
            <Link href="/play" className={btn('secondary', 'xl')}>
              Join with a code
            </Link>
          </div>

          <div className="teacher-proof">
            <div className="avatars">
              {['ada', 'rafi', 'noor'].map((seed) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={seed} src={avatarUrl(seed)} alt="" width={38} height={38} />
              ))}
            </div>
            <p>
              No student accounts. They join with a code
              <br />
              and a nickname, and nothing else.
            </p>
          </div>
        </div>

        {/* The product, not a drawing of it. */}
        <div className="hero-right">
          <span className="live-label" aria-hidden>
            ✦ LIVE CLASSROOM
          </span>

          <div className="quiz-window">
            <div className="flex items-center justify-between border-b border-rule pb-5">
              <span className="cap">Question 4 of 10</span>
              <span className="rounded-pill bg-correct-wash px-3 py-1.5 text-xs font-bold text-correct">
                ● Live
              </span>
            </div>

            <div className="pt-7">
              {/* A <p>, not a heading. This is the mocked screenshot's own question — it
                  titles nothing on this page, and as an <h2> it sat in the document outline
                  between "How it works" and the real sections. */}
              <p className="font-display mb-7 text-[clamp(24px,2.6vw,34px)] leading-tight">
                What is the primary purpose of TCP?
              </p>

              {answers.map((a, i) => (
                <div
                  key={a.letter}
                  className={`answer ${a.letter === 'B' ? 'answer-active' : ''}`}
                >
                  <span className="answer-letter">{a.letter}</span>
                  <span className="answer-text">{a.text}</span>
                  <span
                    className="answer-fill anim-grow-width"
                    style={{ width: `${a.percent}%`, animationDelay: `${i * 80 + 150}ms` }}
                  />
                  <span className="answer-percent tabular">{a.percent}%</span>
                </div>
              ))}

              <div className="mt-6 flex justify-between border-t border-rule pt-4">
                <span className="cap">142 students answering</span>
              </div>
            </div>
          </div>

          <span className="doodle arrow-doodle" aria-hidden>
            ↝
          </span>

          <div className="student-note">
            <span className="cap text-[10px]">Students online</span>
            <strong className="font-display mt-1 block text-[34px] leading-none">142</strong>
          </div>
        </div>
      </section>

      {/* PROCESS STRIP */}
      <section className="process-strip" aria-hidden>
        <span>Upload</span>
        <span>✦</span>
        <span>Generate</span>
        <span>✦</span>
        <span>Review</span>
        <span>✦</span>
        <span>Play</span>
      </section>

      {/* HOW IT WORKS */}
      <section className="how-section" id="how-it-works">
        <div className="how-heading">
          <p className="eyebrow mb-8">How it works</p>
          <h2>
            From lecture material
            <br />
            to a room full of
            <br />
            answers.
          </h2>
        </div>

        <ol className="steps">
          {steps.map((s) => (
            <li key={s.n} className="step">
              <span className="step-number">{s.n}</span>
              <div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <span className="doodle simple-doodle" aria-hidden>
          It&apos;s that
          <br />
          simple! ↘
        </span>
      </section>

      {/* FAQ. Native <details> -- the toggle, the keyboard path and the aria wiring
          come free, and there is no open/closed state to hold. */}
      <section className="faq-section" id="faq">
        <div>
          <p className="eyebrow mb-7">Questions</p>
          <h2>
            Before you
            <br />
            get started.
          </h2>
        </div>

        <div className="faq-list">
          {faqs.map((f) => (
            <details key={f.q} className="faq-item" name="faq">
              <summary>{f.q}</summary>
              <p>{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="final-section">
        <span className="doodle rocket" aria-hidden>
          🚀
        </span>
        <span className="doodle heart" aria-hidden>
          ♡
          <br />
          ♡
        </span>

        <p className="eyebrow mb-6">Ready when you are</p>
        <h2>
          Make your next
          <br />
          lecture <span>playable.</span>
        </h2>
        <p>It takes about a minute.</p>
        <Link href="/login?mode=signup" className={btn('primary', 'xl')}>
          Create your first classroom
        </Link>
      </section>

      </main>

      <SiteFooter />
    </div>
  )
}
