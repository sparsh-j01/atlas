import { cookies, headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { correctOptionId } from '@/lib/mcq'
import { explanationOf, isScored } from '@/lib/slides'
import { currentSlide, sanitizeSlide, slideCount, tallySlideAnswers } from '@/lib/realtime/live-slide'
import { getHostedSession } from '@/lib/sessions'
import { HostConsole } from '@/components/HostConsole'

// The room code, so a host juggling tabs mid-class can tell two live sessions apart.
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  return { title: `Room ${code}` }
}

// The host's live view for a session. Auth is the httpOnly host-token cookie set at launch
// (launchDeckAction), never the URL — so only the creator who launched this session sees it,
// and a shared link is useless to anyone else.
export default async function HostSessionPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const hostToken = (await cookies()).get(`htk_${code}`)?.value ?? ''
  const session = await getHostedSession(code, hostToken)
  if (!session) notFound()

  // Reloading mid-game must land back on the live slide with its clock still running, not a
  // blank console — the same catch-up the participant gets from /state. The correct option
  // and the explanation ride along only once they've already been revealed to the room.
  const slide = await currentSlide(session)
  const revealed = session.status === 'revealed'
  // The answered counter is broadcast-driven, so without seeding it a reload mid-question
  // reads "0 answered" while the room has already responded.
  const tally = slide ? await tallySlideAnswers(session.id, slide.id) : null

  return (
    <HostConsole
      code={session.code}
      // The join URL, resolved server-side. The console used to read window.location.host
      // during render, which is '' on the server — so the first thing painted on the wall
      // was "Join at /play" with the domain missing until hydration. This is the one line a
      // room of students has to read and retype.
      joinHost={(await headers()).get('host') ?? ''}
      total={session.deckId ? await slideCount(session.deckId) : 0}
      initialIndex={session.currentSlideIndex}
      initialStatus={session.status}
      initialSlide={slide && sanitizeSlide(slide)}
      initialAnswered={tally?.total ?? 0}
      // A live poll shows its distribution while voting is still open, so a mid-slide reload
      // has to come back with the tally, not a blank chart. A live quiz must not: the counts
      // stay withheld until the reveal (see isScored).
      initialAggregate={revealed || (slide && !isScored(slide.type)) ? tally : null}
      initialCorrectId={revealed && slide ? correctOptionId(slide.config) : null}
      initialExplanation={revealed && slide ? (explanationOf(slide.config) ?? null) : null}
      initialServerStartedAt={session.currentSlideStartedAt?.toISOString() ?? null}
      initialTimeLimitMs={slide?.config.timeLimitMs ?? null}
    />
  )
}
