import { SiteFooter, SiteHeader } from '@/components/SiteHeader'
import { LAST_UPDATED } from './legal-info'

/**
 * Chrome and typography for the two legal documents, so the pages themselves are prose and
 * nothing else. Element selectors rather than a class on every tag — there are a few hundred
 * of them across the two files and none of them wants a bespoke style.
 */
const prose = [
  'text-[15px] leading-relaxed text-dim',
  '[&_h2]:mt-14 [&_h2]:font-display [&_h2]:text-[28px] [&_h2]:leading-tight [&_h2]:text-ink',
  '[&_h3]:mt-8 [&_h3]:font-semibold [&_h3]:text-ink',
  '[&_p]:mt-4 [&_ul]:mt-4 [&_ol]:mt-4',
  '[&_li]:mt-2 [&_li]:pl-1 [&_ul]:list-disc [&_ol]:list-decimal [&_ul]:pl-5 [&_ol]:pl-5',
  '[&_strong]:font-semibold [&_strong]:text-ink',
  '[&_a]:font-semibold [&_a]:text-ink [&_a]:underline',
  '[&_table]:mt-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-left',
  '[&_th]:border-b [&_th]:border-rule [&_th]:py-2 [&_th]:pr-4 [&_th]:align-top [&_th]:text-ink',
  '[&_td]:border-b [&_td]:border-rule [&_td]:py-2 [&_td]:pr-4 [&_td]:align-top',
].join(' ')

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main id="main" className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
        <article className={prose}>{children}</article>
        <p className="mt-16 border-t border-rule pt-6 text-sm text-faint">
          Last updated {LAST_UPDATED}.
        </p>
      </main>
      <SiteFooter />
    </div>
  )
}
