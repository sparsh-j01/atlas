import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants, sessions } from '@/lib/db/schema'
import { isRoomCode, isUuid } from '@/lib/ids'
import { getHostedSession } from '@/lib/sessions'
import { bad, hostTokenFrom } from '@/lib/realtime/session-util'
import { progressSession, readProgressState } from '@/lib/realtime/session-progress'

export const dynamic = 'force-dynamic'

// A participant may wake an expired question, but cannot start, skip, reveal, or end early.
// This keeps the room moving even if the teacher's tab is backgrounded. Requests name the
// question they saw, so a retry cannot consume the following question's answer window.
async function authorizedSession(req: Request, code: string) {
  if (!isRoomCode(code)) return null
  const clientToken = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim()
  if (clientToken && isUuid(clientToken)) {
    const [row] = await db.select({ session: sessions }).from(sessions)
      .innerJoin(participants, and(eq(participants.sessionId, sessions.id), eq(participants.clientToken, clientToken)))
      .where(eq(sessions.code, code)).limit(1)
    if (row) return row.session
  }
  return getHostedSession(code, await hostTokenFrom(req, code), true)
}

export async function GET(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const session = await getHostedSession((await params).code, await hostTokenFrom(req, (await params).code), true)
  if (!session) return bad(404, 'session not found')
  return Response.json(await readProgressState(session), { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const session = await authorizedSession(req, code)
  if (!session) return bad(404, 'session not found')
  const body = await req.json().catch(() => null)
  if (!Number.isInteger(body?.index) || typeof body?.serverStartedAt !== 'string' || !Number.isFinite(Date.parse(body.serverStartedAt))) {
    return bad(400, 'question index and start time are required')
  }
  const state = await progressSession(session, { index: body.index, serverStartedAt: body.serverStartedAt })
  if (!state) return bad(404, 'session not found')
  return Response.json(state, { headers: { 'Cache-Control': 'no-store' } })
}
