import { eq, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { participants } from '@/lib/db/schema'
import { sanitizeNickname } from '@/lib/nickname'
import { currentSlide, sanitizeSlide } from '@/lib/realtime/live-slide'
import { bad, findLiveSession, newToken } from '@/lib/realtime/session-util'
import { answersOpen } from '@/lib/realtime/session-state'

// Abuse guard on joins: a ceiling on how many participants ONE room may hold.
//
// The obvious guard — N joins per minute per IP — is wrong for this product and actively
// breaks it. A class joins from one school's wifi, so 30 students share a public IP (and
// often a user-agent). An IP limiter reads a normal classroom as an attack and 429s
// everyone after the tenth, which is the exact scenario the whole app exists to serve.
// The room is the thing worth protecting, so the room is the key, and the count lives in
// the participants table — real shared state, correct across serverless instances, unlike
// a per-process Map that each Vercel lambda would keep its own copy of.
//
// 300 sits far above the 100+ target so a real room never meets it.
// ponytail: a determined attacker can still fill one room up to the cap, and the host's
// answer to that is /kick plus ending the session. Upgrade path if it ever matters:
// require a host-issued join code per participant.
const MAX_PARTICIPANTS_PER_SESSION = 300

// Anonymous participant join. Issues the SERVER-side client_token (identity); a
// client-set token is never trusted. Returns the live slide (if one is open) so the player
// can render immediately without racing the slide:show broadcast — a join during the lobby
// or a reveal gets null and waits for the next broadcast.
export async function POST(req: Request, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params

  const body = await req.json().catch(() => null)
  // Trim, length, invisible characters and the blocklist, in one call — this nickname goes
  // on a projector in front of a room, and there is no account behind it to appeal to.
  // Server-side because it is the only side that counts; the filter is deliberately beatable,
  // which is why the host also gets /kick.
  const checked = sanitizeNickname(body?.nickname)
  if (!checked.ok) return bad(400, checked.error)
  const { nickname } = checked

  const session = await findLiveSession(code)
  if (!session) return bad(404, 'session not found')

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(participants)
    .where(eq(participants.sessionId, session.id))
  if (n >= MAX_PARTICIPANTS_PER_SESSION)
    return bad(429, 'This room is full.')

  const clientToken = newToken()
  const avatarSeed = nickname // DiceBear seed; deterministic avatar from the nickname
  const [p] = await db
    .insert(participants)
    .values({ sessionId: session.id, nickname, avatarSeed, clientToken })
    .returning({ id: participants.id })

  const slide = answersOpen(session) ? await currentSlide(session) : null
  return Response.json({
    clientToken,
    participantId: p.id,
    // Returned so the client tracks the SANITIZED name into presence. sanitizeNickname
    // strips zero-width and directional marks rather than rejecting them, so the string the
    // player typed and the string that passed the filter are not always the same one — and
    // presence is what the projector renders.
    nickname,
    avatarSeed,
    status: session.status,
    index: session.currentSlideIndex,
    slide: slide && sanitizeSlide(slide),
    serverStartedAt: session.currentSlideStartedAt?.toISOString() ?? null,
    timeLimitMs: slide?.config.timeLimitMs ?? null,
  })
}
