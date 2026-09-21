/** Date and time are formatted SEPARATELY and joined here. One combined formatter let each
 *  ICU build pick its own joiner: Node rendered "6 Oct 2026 at 00:00", Safari "6 Oct 2026,
 *  00:00", and the server/hydration mismatch threw on /usage. */
export function formatLocalTime(iso: string, dateOnly: boolean, timeZone?: string): string {
  const d = new Date(iso)
  const date = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(d)
  if (dateOnly) return date
  const time = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(d)
  return `${date}, ${time}`
}
