import type { Metadata } from 'next'
import { Geist, Geist_Mono, Gowun_Batang } from 'next/font/google'
import './globals.css'

// Display face. A book serif, set at normal weight, is what makes this read as a page from
// the course rather than a SaaS landing template. It only ever sets headings and figures --
// never body copy, never UI chrome.
const gowunBatang = Gowun_Batang({
  variable: '--font-gowun',
  subsets: ['latin'],
  weight: ['400', '700'],
  display: 'swap',
})

// Body and UI. Geist is a neutral grotesque that stays quiet next to the serif, which is the
// job: the serif carries the voice, the sans carries the information.
const geist = Geist({
  variable: '--font-geist',
  subsets: ['latin'],
  display: 'swap',
})

// Scores, room codes and countdowns are the figures people read from the back of a room, and
// they change in place. Tabular mono keeps them from jittering.
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Atlas',
  description: 'Live in-class quizzes built from your own lecture material.',
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${gowunBatang.variable} ${geist.variable} ${geistMono.variable} h-full`}
    >
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  )
}
