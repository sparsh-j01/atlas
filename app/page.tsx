import { ArrowRight, CheckCircle } from '@phosphor-icons/react/ssr'
import Link from 'next/link'
import { JoinCodeForm } from '@/components/landing/JoinCodeForm'
import { ProjectorPreview } from '@/components/landing/ProjectorPreview'
import { RerankDemo } from '@/components/landing/RerankDemo'
import { Enter, Reveal } from '@/components/landing/Reveal'
import { ProjectorSlide } from '@/components/ProjectorSlide'
import { arrowLinkCls, btn, capCls, cardCls } from '@/components/ui'

/**
 * Atlas landing page.
 *
 * Paper, set like a page from the course rather than a product site: warm off-white, a book
 * serif at normal weight for every heading, small quiet sans for everything else, and a lot of
 * air. The type does the work, so there is almost no chrome -- no gradient panels, no icon
 * grid, no section inverts.
 *
 * The one dark thing on the page is the product itself. Every preview here renders the same
 * components the live room renders (ProjectorSlide, Leaderboard) inside a `.stage` subtree, so
 * the marketing page cannot drift from what a class actually sees, and the projector reads as a
 * projector: a lit screen on a paper page.
 */

const STEPS = [
  {
    verb: 'Upload',
    body: 'Drop in the lecture PDF you already teach from. Atlas reads it, splits it into passages, and indexes them.',
  },
  {
    verb: 'Review',
    body: 'The draft opens in the editor. Reword a question, swap the answer, cut a slide. It cannot host until you mark it ready.',
  },
  {
    verb: 'Present',
    body: 'Put the room code on the projector. Students join in seconds, and the board settles at every reveal.',
  },
]

// Stands where a landing page usually puts customer logos. Atlas has no customers to name yet,
// and inventing a logo wall is the one thing on a page like this that is actually dishonest, so
// the slot holds facts about the product instead.
const FACTS = [
  { figure: '100+', label: 'in one room' },
  { figure: '6', label: 'digits to join' },
  { figure: 'No', label: 'student signup' },
  { figure: 'Every', label: 'question cited' },
]

const CONTRASTS = [
  {
    title: 'Not a form',
    body: 'A form collects answers whenever people get round to it. Atlas runs a room on one clock, with everyone on the same question at the same second.',
  },
  {
    title: 'Not a chatbot prompt',
    body: 'Ask a general model for ten questions on conformity and it writes ten plausible ones. None of them are from your chapter.',
  },
  {
    title: 'Not a stock deck',
    body: 'Someone else already made a quiz on this topic. It does not follow your reading, your emphasis, or your slides.',
  },
]

const EXAMPLE = {
  prompt: 'What does diffusion of responsibility describe?',
  options: [
    { id: 'a', text: 'Nobody helps, because each person assumes somebody else will', correct: true },
    { id: 'b', text: 'A crowd reaches a decision faster than one person would', correct: false },
    { id: 'c', text: 'Responsibility passes to whoever has the most training', correct: false },
    { id: 'd', text: 'Group members split a task into equal shares', correct: false },
  ],
}

/**
 * Window chrome around a live preview. The dots are the cheapest possible signal that what is
 * inside is a running screen and not an illustration, which is the whole reason the previews on
 * this page are real components.
 */
function Screen({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-rule bg-raised shadow-lift-high">
      <div className="flex items-center gap-2 border-b border-rule px-4 py-3">
        <span className="flex gap-1.5" aria-hidden>
          <span className="h-[9px] w-[9px] rounded-full bg-rule-strong" />
          <span className="h-[9px] w-[9px] rounded-full bg-rule-strong" />
          <span className="h-[9px] w-[9px] rounded-full bg-rule-strong" />
        </span>
        {label ? <span className={`${capCls} ml-1.5`}>{label}</span> : null}
      </div>
      <div className="stage">{children}</div>
    </div>
  )
}

export default function Home() {
  return (
    <main className="bg-ground text-ink">
      {/* Nav. Quiet and short: a 56px line, a wordmark, and the two things you can do. */}
      <header className="sticky top-0 z-40 bg-ground/85 backdrop-blur-sm">
        <nav className="mx-auto flex h-14 max-w-[1320px] items-center justify-between px-6 lg:px-10">
          <Link href="/" className="font-display text-[19px]">
            Atlas
          </Link>
          <div className="flex items-center gap-4 sm:gap-6">
            <Link href="/play" className="text-sm text-dim transition-colors hover:text-ink">
              Join a room
            </Link>
            <Link href="/dashboard" className={btn('primary', 'md')}>
              Host a session
            </Link>
          </div>
        </nav>
      </header>

      {/* 1. Hero. The claim on the left at reading size, the running projector on the right. */}
      <section className="mx-auto grid max-w-[1320px] items-center gap-12 px-6 pt-14 pb-20 lg:grid-cols-12 lg:gap-16 lg:px-10 lg:pt-20 lg:pb-28">
        <div className="lg:col-span-5">
          <Enter>
            <h1 className="font-display text-[40px] leading-[1.04] sm:text-[54px]">
              Your lecture,
              <br />
              as a live game.
            </h1>
          </Enter>
          <Enter delay={0.12}>
            <p className="mt-6 max-w-[42ch] text-[15px] leading-[1.65] text-dim">
              Atlas builds a quiz from the PDF you already teach from, cites the passage behind
              every question, and runs the room on one clock. Students join with six digits and
              no account.
            </p>
          </Enter>
          <Enter delay={0.24}>
            <div className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-4">
              <Link href="/dashboard" className={btn('primary', 'xl')}>
                Host a session
              </Link>
              <Link href="/play" className={arrowLinkCls}>
                Join a room
                <ArrowRight
                  size={15}
                  className="transition-transform group-hover:translate-x-0.5"
                  aria-hidden
                />
              </Link>
            </div>
          </Enter>
        </div>
        <Enter delay={0.3} className="lg:col-span-7">
          <Screen label="On the projector">
            <ProjectorPreview />
          </Screen>
        </Enter>
      </section>

      {/* 2. Facts row. Sits where a logo wall would, and says something true instead. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-20 lg:px-10 lg:pb-28">
        <Reveal>
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 border-y border-rule py-9 sm:grid-cols-4">
            {FACTS.map((f) => (
              <div key={f.label} className="flex flex-col gap-1">
                <span className="font-display text-[26px] leading-none">{f.figure}</span>
                <span className="text-[13px] text-faint">{f.label}</span>
              </div>
            ))}
          </div>
        </Reveal>
      </section>

      {/* 3. How it runs. Heading, one line of support, three cards. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 lg:px-10 lg:pb-32">
        <Reveal className="max-w-[34ch]">
          <h2 className="font-display text-[30px] leading-[1.18] sm:text-[34px]">
            Three moves, then you present.
          </h2>
          <p className="mt-3 text-[15px] leading-[1.6] text-faint">
            No new material to prepare. The deck comes out of the reading you already set.
          </p>
        </Reveal>
        <div className="mt-11 grid gap-5 md:grid-cols-3">
          {STEPS.map((step, i) => (
            <Reveal key={step.verb} delay={i * 0.07}>
              <div className={`${cardCls} h-full p-7`}>
                <span className="font-display text-[15px] text-lamp">0{i + 1}</span>
                <h3 className="font-display mt-5 text-[21px]">{step.verb}</h3>
                <p className="mt-2.5 text-[14px] leading-[1.65] text-dim">{step.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 4. Grounding. A real generated question, with the passage it came from. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 lg:px-10 lg:pb-32">
        <Reveal className="mx-auto max-w-[52ch] text-center">
          <h2 className="font-display text-[30px] leading-[1.18] sm:text-[34px]">
            Every question points back at a passage.
          </h2>
          <p className="mt-4 text-[15px] leading-[1.65] text-faint">
            Atlas searches your document for the passages that answer a question, then writes
            from those and nothing else. If the document does not cover it, no question is
            produced.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mx-auto mt-12 max-w-[42rem]">
          <div className={`${cardCls} p-7 sm:p-9`}>
            <p className="font-display text-[23px] leading-[1.3] sm:text-[26px]">
              {EXAMPLE.prompt}
            </p>
            <ul className="mt-7 flex flex-col gap-2.5">
              {EXAMPLE.options.map((opt) => (
                <li
                  key={opt.id}
                  className={`flex items-start gap-3 rounded-plate border px-4 py-3.5 text-[14px] leading-[1.55] ${
                    opt.correct
                      ? 'border-correct/40 bg-correct/8 text-ink'
                      : 'border-rule text-dim'
                  }`}
                >
                  {opt.correct ? (
                    <CheckCircle
                      size={18}
                      weight="regular"
                      className="mt-px shrink-0 text-correct"
                      aria-hidden
                    />
                  ) : (
                    <span className="mt-px w-[18px] shrink-0" aria-hidden />
                  )}
                  {opt.text}
                </li>
              ))}
            </ul>
            <div className="mt-7 flex flex-wrap items-center gap-2.5 border-t border-rule pt-6">
              <span className="rounded-plate border border-lamp/25 bg-lamp-wash px-2.5 py-1 font-data text-[11px] text-lamp">
                Cited
              </span>
              <span className="text-[13px] text-faint">
                Social Psychology &middot; Helping Behaviour
              </span>
            </div>
          </div>
          <p className="mt-4 text-center text-[13px] text-faint">
            Generated from an OpenStax chapter during testing.
          </p>
        </Reveal>
      </section>

      {/* 5. The re-rank. The product's own Leaderboard, running. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 lg:px-10 lg:pb-32">
        <Reveal className="max-w-[40ch]">
          <h2 className="font-display text-[30px] leading-[1.18] sm:text-[34px]">
            The board moves when the answer lands.
          </h2>
          <p className="mt-3 text-[15px] leading-[1.6] text-faint">
            Ranks settle once per reveal instead of on every incoming answer. That is what keeps
            a room of a hundred steady, and it is what makes the reorder worth watching.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-11">
          <RerankDemo />
        </Reveal>
      </section>

      {/* 6. Two screens, one question. Both are lit screens, so both sit in a stage. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 lg:px-10 lg:pb-32">
        <Reveal className="max-w-[40ch]">
          <h2 className="font-display text-[30px] leading-[1.18] sm:text-[34px]">
            One room, two screens.
          </h2>
          <p className="mt-3 text-[15px] leading-[1.6] text-faint">
            Options are lettered, never colour-coded, so the wall and the phone match on the same
            glyph.
          </p>
        </Reveal>
        <div className="mt-11 grid gap-8 lg:grid-cols-12 lg:gap-12">
          <Reveal className="lg:col-span-8">
            <Screen label="Projector">
              <div className="p-7">
                <ProjectorSlide
                  prompt={EXAMPLE.prompt}
                  options={EXAMPLE.options}
                  size="preview"
                />
              </div>
            </Screen>
            <p className="mt-4 text-[14px] leading-[1.6] text-faint">
              The wall carries the question and the clock, nothing else.
            </p>
          </Reveal>
          <Reveal delay={0.1} className="lg:col-span-4">
            <div className="stage mx-auto max-w-[17rem] rounded-[26px] border border-rule bg-ground p-3 shadow-lift-high">
              <div className="rounded-[18px] bg-raised p-3">
                <ul className="flex flex-col gap-2">
                  {EXAMPLE.options.map((opt, i) => (
                    <li
                      key={opt.id}
                      className="flex items-center gap-3 rounded-plate border border-rule bg-ground px-3 py-3"
                    >
                      <span
                        aria-hidden
                        className="font-data grid h-7 w-7 shrink-0 place-items-center rounded-plate bg-overlay text-[12px] text-dim"
                      >
                        {['A', 'B', 'C', 'D'][i]}
                      </span>
                      <span className="line-clamp-2 text-[13px] leading-snug text-ink">
                        {opt.text}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="mt-4 text-[14px] leading-[1.6] text-faint">
              The phone is four tiles. No app, no account, no password to reset.
            </p>
          </Reveal>
        </div>
      </section>

      {/* 7. The review gate. A statement, set wide and centred, with no visual. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 lg:px-10 lg:pb-32">
        <Reveal className="mx-auto max-w-[46ch] border-y border-rule py-16 text-center lg:py-20">
          <h2 className="font-display text-[30px] leading-[1.18] sm:text-[34px]">
            Nothing reaches the room unread.
          </h2>
          <p className="mt-4 text-[15px] leading-[1.65] text-dim">
            A generated question has to pass validation before it can be presented, and a second
            model checks that the marked answer is actually supported by the passage. Anything
            that fails is dropped rather than shipped unverified. Then you read the deck
            yourself.
          </p>
        </Reveal>
      </section>

      {/* 8. Positioning. Three plain columns under a hairline each. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 lg:px-10 lg:pb-32">
        <Reveal className="max-w-[30ch]">
          <h2 className="font-display text-[30px] leading-[1.18] sm:text-[34px]">
            Close to three things. None of them.
          </h2>
        </Reveal>
        <div className="mt-11 grid gap-10 md:grid-cols-3 md:gap-8">
          {CONTRASTS.map((c, i) => (
            <Reveal key={c.title} delay={i * 0.07}>
              <div className="border-t border-ink pt-5">
                <h3 className="font-display text-[19px]">{c.title}</h3>
                <p className="mt-2.5 text-[14px] leading-[1.65] text-dim">{c.body}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* 9. Join. The participant path, and the pricing moment in one. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 text-center lg:px-10 lg:pb-32">
        <Reveal className="mx-auto max-w-[46ch]">
          <h2 className="font-display text-[30px] leading-[1.18] sm:text-[34px]">
            Got a code?
          </h2>
          <p className="mt-4 text-[15px] leading-[1.65] text-faint">
            Type the six digits on the projector. That is the entire sign in, and it is free
            while Atlas is in development.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mx-auto mt-10 max-w-[26rem] text-left">
          <JoinCodeForm />
        </Reveal>
      </section>

      {/* 10. Closing line. The serif gets the last word. */}
      <section className="mx-auto max-w-[1320px] px-6 pb-24 lg:px-10 lg:pb-32">
        <Reveal className="mx-auto max-w-[38ch] text-center">
          <p className="font-display text-[24px] leading-[1.35] sm:text-[28px]">
            A class already knows more than a form can ask it.
          </p>
        </Reveal>
      </section>

      <footer className="border-t border-rule">
        <div className="mx-auto flex max-w-[1320px] flex-col items-start justify-between gap-6 px-6 py-10 sm:flex-row sm:items-center lg:px-10">
          <div>
            <span className="font-display text-[17px]">Atlas</span>
            <p className="mt-1 text-[13px] text-faint">
              Live in-class quizzes built from your own lecture material
            </p>
          </div>
          <div className="flex items-center gap-6">
            <Link href="/play" className="text-[13px] text-dim transition-colors hover:text-ink">
              Join a room
            </Link>
            <Link
              href="/dashboard"
              className="text-[13px] text-dim transition-colors hover:text-ink"
            >
              Host a session
            </Link>
          </div>
        </div>
      </footer>
    </main>
  )
}
