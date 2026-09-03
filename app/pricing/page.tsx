import Link from 'next/link'
import { MarketingNav, SiteFooter, SiteHeader } from '@/components/SiteHeader'
import { btn, cardCls, panelCls } from '@/components/ui'

export const metadata = { title: 'Pricing' }

// ponytail: prices and limits are plain data, not a billing integration. When Stripe
// lands, these strings become the product catalogue's — nothing else on the page moves.
const tiers = [
  {
    name: 'Free',
    price: '₹0',
    unit: 'forever',
    blurb: 'One teacher, one class at a time.',
    cta: 'Start free',
    href: '/login?mode=signup',
    features: [
      'Up to 50 students in a room',
      'Unlimited hand-built decks',
      '3 AI-generated decks a month, from a topic',
      'Quiz and poll slides, live leaderboard',
      'Projector view and six-digit join codes',
    ],
  },
  {
    name: 'Pro',
    price: '₹999',
    unit: 'per teacher / month',
    blurb: 'For someone who teaches every week.',
    featured: true,
    cta: 'Start with Pro',
    href: '/login?mode=signup',
    features: [
      'Everything in Free',
      'Up to 300 students in a room',
      'Unlimited AI decks, from a topic or a lecture PDF',
      'Questions grounded in your document, with the passage they came from',
      'Session history you can reopen and re-run',
      'Email support',
    ],
  },
  {
    name: 'University',
    price: 'Custom',
    unit: 'billed annually',
    blurb: 'A department, a faculty, or the whole campus.',
    cta: 'Talk to us',
    // ponytail: placeholder inbox — swap for the real one before this goes public.
    href: 'mailto:hello@atlas.example',
    features: [
      'Everything in Pro',
      'Seats for your whole department',
      'A shared deck library across teachers',
      'SSO and invoiced billing',
      'Onboarding session and a named contact',
    ],
  },
]

const faqs = [
  {
    q: 'Do students ever pay?',
    a: 'No, and they never sign up either. They join with the six-digit code on your screen and a nickname. Plans price the teacher hosting the room, not the people in it.',
  },
  {
    q: 'What counts as a student in the room limit?',
    a: 'Everyone joined to one live session at the same time. It is a ceiling per room, not a total for the term — you can run the same deck with a new group the next hour.',
  },
  {
    q: 'What happens if I stop paying for Pro?',
    a: 'Your account drops back to Free. Every deck you built stays, including the AI-generated ones; you just go back to the Free room limit and monthly generation allowance.',
  },
  {
    q: 'Can I try Pro before deciding?',
    a: 'Start on Free and upgrade whenever the room outgrows it. Nothing you build has to be rebuilt when you switch.',
  },
]

export default function Pricing() {
  return (
    <div className="atlas-page">
      <SiteHeader wide>
        <MarketingNav current="pricing" />

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
        <section className="px-6 pt-14 pb-12 text-center lg:px-[4.5vw]">
          <p className="eyebrow mb-6">Pricing</p>
          <h1 className="font-display mx-auto max-w-[16ch] text-[clamp(40px,5.6vw,74px)] leading-[0.95]">
            Pay for the room you host.
          </h1>
          <p className="mx-auto mt-7 max-w-[54ch] text-[17px] leading-relaxed text-dim">
            Students never pay and never make an account. Every plan runs the same live
            room — the difference is how big it gets and how much of the deck Atlas writes
            for you.
          </p>
        </section>

        <section className="mx-auto grid max-w-6xl gap-6 px-6 pb-6 md:grid-cols-3">
          {tiers.map((t) => (
            <div
              key={t.name}
              className={`relative flex flex-col p-8 ${
                t.featured ? `${cardCls} border-pen` : panelCls
              }`}
            >
              {t.featured && (
                <span className="absolute -top-3 left-8 rounded-pill bg-pen px-3 py-1 text-[11px] font-bold uppercase tracking-[0.16em] text-pen-on">
                  Most teachers
                </span>
              )}

              <h2 className="font-display text-[26px] leading-none">{t.name}</h2>
              {/* Two lines reserved so the three price rows and CTAs sit on one line
                  across the row, whether the blurb wraps or not. */}
              <p className="mt-3 text-sm text-dim md:min-h-[2.9em]">{t.blurb}</p>

              <p className="mt-7 flex flex-wrap items-baseline gap-x-2">
                <span className="font-display text-[46px] leading-none">{t.price}</span>
                <span className="text-sm text-dim">{t.unit}</span>
              </p>

              <Link
                href={t.href}
                className={`${btn(t.featured ? 'primary' : 'secondary', 'lg')} mt-7 w-full`}
              >
                {t.cta}
              </Link>

              <ul className="mt-8 flex flex-col gap-3 text-[15px] leading-snug">
                {t.features.map((f) => (
                  <li key={f} className="flex gap-3">
                    <span aria-hidden className="text-pen-ink">
                      ✦
                    </span>
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>

        <p className="mx-auto max-w-6xl px-6 pb-24 pt-8 text-center text-sm text-dim">
          Every plan: no student accounts, no app to install, and a deck you have read
          before anyone else sees it.
        </p>

        {/* Same native <details> rows as the landing FAQ — the styles are already global. */}
        <section className="faq-section">
          <div>
            <p className="eyebrow mb-7">Billing</p>
            <h2>
              The money
              <br />
              questions.
            </h2>
          </div>

          <div className="faq-list">
            {faqs.map((f) => (
              <details key={f.q} className="faq-item" name="pricing-faq">
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        <section className="final-section">
          <p className="eyebrow mb-6">Ready when you are</p>
          <h2>
            Start on <span>Free.</span>
          </h2>
          <p>Upgrade the day a room outgrows it.</p>
          <Link href="/login?mode=signup" className={btn('primary', 'xl')}>
            Create your first classroom
          </Link>
        </section>
      </main>

      <SiteFooter />
    </div>
  )
}
