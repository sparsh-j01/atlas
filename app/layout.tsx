import type { Metadata } from 'next'
import { Caveat, DM_Sans, Playfair_Display } from 'next/font/google'
import './globals.css'

// Print. The material itself -- headings, question prompts, figures that sit still.
// A book serif is what makes this read as a page from the course rather than a SaaS
// template. It never sets body copy or UI chrome.
const playfair = Playfair_Display({
  variable: '--font-playfair',
  subsets: ['latin'],
  weight: ['600', '700', '800'],
  display: 'swap',
})

// Pen. The teacher's marks on top of the material: logo, room code, live labels,
// empty-state asides. Annotation only -- see the .font-pen rule in globals.css.
const caveat = Caveat({
  variable: '--font-caveat',
  subsets: ['latin'],
  weight: ['600', '700'],
  display: 'swap',
})

// Body and UI. Stays quiet next to the serif, which is the job: the serif carries the
// voice, the sans carries the information. Its tabular figures are why no monospace
// face is loaded -- room codes are digits-only, so there is no 0/O to disambiguate.
const dmSans = DM_Sans({
  variable: '--font-dm-sans',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  // A template, not a fixed string. A teacher runs a class with five of these open at once
  // (dashboard, editor, host console, projector, phone) and identical tab titles make them
  // indistinguishable -- WCAG 2.4.2. Each page sets its own segment; only the landing page
  // takes the bare default.
  title: { default: 'Atlas', template: '%s · Atlas' },
  description: 'Live in-class quizzes built from your own lecture material.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // data-scroll-behavior: globals.css sets `scroll-behavior: smooth` on <html>, and Next 16
    // no longer assumes it should suppress that during a route transition — it warns until
    // the intent is declared. Declaring it keeps the pre-16 behaviour (smooth in-page anchors,
    // instant on navigation) and clears the only console warning in the app.
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${playfair.variable} ${caveat.variable} ${dmSans.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
