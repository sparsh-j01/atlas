import { NextResponse } from 'next/server'
import { bearerMatches } from '@/lib/crypto'
import { reapDocuments } from '@/lib/documents'
import { purgeExpiredWindows } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

// Daily housekeeping, scheduled in vercel.json (Hobby allows one run a day).
//
// - Abandoned uploads. Ingestion is driven by the browser, so a teacher who closes the tab
//   mid-upload leaves the file in storage and the document stuck mid-pipeline forever —
//   nothing else would ever touch it. See reapDocuments for what counts as abandoned.
// - Ended rate-limit windows. Every check writes a row; without this the table only grows.
//
// Vercel Cron calls this with `Authorization: Bearer $CRON_SECRET`. Without the env var the
// route refuses everything: an open endpoint that deletes documents is not a default.

export async function GET(req: Request) {
  if (!bearerMatches(req.headers.get('authorization'), process.env.CRON_SECRET))
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 })

  const documents = await reapDocuments()
  const windows = await purgeExpiredWindows()
  const result = { ...documents, windows }
  logger.info('daily cron', result)
  return NextResponse.json(result)
}
