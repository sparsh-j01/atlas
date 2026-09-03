import Link from 'next/link'

/**
 * The one piece of chrome every surface shares: 72px, a hairline rule, and the
 * wordmark in pen. The landing page and the creator area differ only in what they
 * hang on the right, which is the `children` slot.
 *
 * Sticky with a translucent ground, so the rule stays put while long pages (the deck
 * list, the editor) scroll under it.
 */
export function SiteHeader({
  href = '/',
  children,
  wide = false,
}: {
  /** Where the wordmark goes. Landing → '/', signed in → '/dashboard'. */
  href?: string
  children?: React.ReactNode
  /** Landing uses the full viewport width; the app centres on its content column. */
  wide?: boolean
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-rule bg-ground/90 backdrop-blur">
      {/* First focusable thing on the page. Hidden until it takes focus, then it sits over
          the header. Every surface that renders this header gives its main landmark
          id="main" — a skip link pointing at nothing is worse than none. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-pill focus:bg-ink focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ground"
      >
        Skip to content
      </a>
      <div
        className={`flex h-[72px] items-center justify-between gap-4 px-6 lg:px-[4.5vw] ${
          wide ? '' : 'mx-auto max-w-6xl lg:px-6'
        }`}
      >
        <Link href={href} className="font-pen text-[30px] leading-none tracking-wide">
          ATLAS <span className="text-pen">✦</span>
        </Link>
        {children}
      </div>
    </header>
  )
}

/**
 * The marketing nav, shared by the landing page and /pricing.
 *
 * Section links are absolute (`/#how-it-works`), which the browser treats as a plain
 * fragment scroll when you are already on `/` and as a navigation when you are not —
 * so one set of links works from both pages.
 */
export function MarketingNav({ current }: { current?: 'pricing' }) {
  return (
    <nav className="hidden gap-9 text-sm md:flex">
      <Link href="/#how-it-works" className="transition-opacity hover:opacity-55">
        How it works
      </Link>
      <Link
        href="/pricing"
        aria-current={current === 'pricing' ? 'page' : undefined}
        className="transition-opacity hover:opacity-55 aria-[current=page]:font-semibold aria-[current=page]:text-pen-ink"
      >
        Pricing
      </Link>
      <Link href="/#faq" className="transition-opacity hover:opacity-55">
        FAQ
      </Link>
    </nav>
  )
}

/** The wordmark rule at the bottom of every marketing page. */
export function SiteFooter() {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-rule px-6 py-8 text-sm text-dim lg:px-[4.5vw]">
      <span className="font-pen text-[25px] leading-none text-ink">
        ATLAS <span className="text-pen">✦</span>
      </span>
      {/* The nav is desktop-only (no mobile menu on this site), so the footer is where
          a phone finds the pricing page. */}
      <Link href="/pricing" className="hover:underline md:hidden">
        Pricing
      </Link>
      <span className="hidden md:inline">Interactive learning, built for the classroom.</span>
      <span>© 2026 Atlas</span>
    </footer>
  )
}
