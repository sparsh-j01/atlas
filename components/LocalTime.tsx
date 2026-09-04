'use client'

import { useIsClient } from '@/lib/use-is-client'

/**
 * A timestamp in the reader's own timezone.
 *
 * Server-rendered dates are formatted in the SERVER's zone, which on Vercel is UTC. A class
 * run at 14:00 IST would list as "08:30" for the teacher who ran it, and two sections of the
 * same lecture on the same day would be told apart by a wrong pair of numbers. Formatting has
 * to happen where the reader is.
 *
 * The server pass and the hydrating render both format in UTC so the two agree; `useIsClient`
 * then flips and the same pure render formats locally. `dateTime` carries the machine
 * readable instant throughout, which is what a screen reader and a copy-paste get either way.
 */
export function LocalTime({ iso, dateOnly = false }: { iso: string; dateOnly?: boolean }) {
  const isClient = useIsClient()
  const opts: Intl.DateTimeFormatOptions = {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(dateOnly ? {} : { hour: '2-digit', minute: '2-digit' }),
    // Undefined means "the reader's zone", which is the whole point; UTC is only the
    // placeholder that keeps the two first renders identical.
    ...(isClient ? {} : { timeZone: 'UTC' }),
  }

  return (
    <time dateTime={iso}>{new Intl.DateTimeFormat('en-GB', opts).format(new Date(iso))}</time>
  )
}
