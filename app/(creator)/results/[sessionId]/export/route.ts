import { requireUser } from '@/lib/auth'
import { getSessionResults } from '@/lib/sessions'
import { csvFilename, toGradebookCsv } from '@/lib/results'

/**
 * The gradebook CSV for one finished session.
 *
 * A route handler under the creator segment rather than `/api/sessions/...`: that tree is
 * keyed by the 6-digit CODE and authorized by the host token, and a code is released for
 * reuse the moment a session ends (`sessions_active_code_idx` is partial on
 * `status <> 'ended'`), so it cannot name a finished game. This is keyed by session id and
 * authorized by the creator's own login, which is also what makes the file reachable weeks
 * later, after the 6-hour host-token cookie is long gone.
 *
 * GET with no side effects, so a download link, a bookmark and a prefetch are all safe.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const user = await requireUser()
  const { sessionId } = await params
  const page = await getSessionResults(sessionId, user.id)
  // Same 404 as the page: not yours, or not over yet.
  if (!page) return new Response('Not found', { status: 404 })

  const filename = csvFilename(page.deckTitle, page.session.endedAt ?? page.session.createdAt)
  return new Response(toGradebookCsv(page.results), {
    headers: {
      // charset in the type as well as the BOM in the body: between them, every spreadsheet
      // and text editor reads the nicknames correctly.
      'Content-Type': 'text/csv; charset=utf-8',
      // The filename is derived from a creator-controlled deck title, so it is slugged to
      // [a-z0-9-] in csvFilename before it reaches this header — a raw title containing a
      // quote or a newline would otherwise let it break out of the header value.
      'Content-Disposition': `attachment; filename="${filename}"`,
      // A results file is per-creator and changes when a deck is edited underneath it.
      'Cache-Control': 'private, no-store',
    },
  })
}
