import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { correctOptionId } from '@/lib/mcq'
import { currentSlide, sanitizeSlide, slideCount } from '@/lib/realtime/live-slide'
import { getHostedSession } from '@/lib/sessions'
import { HostConsole } from '@/components/HostConsole'

// The host's live view for a session. Auth is the httpOnly host-token cookie set at launch
// (launchDeckAction), never the URL — so only the creator who launched this session sees it,
// and a shared link is useless to anyone else.
export default async function HostSessionPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const hostToken = (await cookies()).get(`htk_${code}`)?.value ?? ''
  const session = await getHostedSession(code, hostToken)
  if (!session) notFound()

  // Reloading mid-game must land back on the live slide, not a blank console — the same
  // catch-up the participant gets from /state. The correct option rides along only once
  // it's already been revealed to the room.
  const slide = await currentSlide(session)
  const revealed = session.status === 'revealed'

  return (
    <HostConsole
      code={session.code}
      total={session.deckId ? await slideCount(session.deckId) : 0}
      initialIndex={session.currentSlideIndex}
      initialStatus={session.status}
      initialSlide={slide && sanitizeSlide(slide)}
      initialCorrectId={revealed && slide ? correctOptionId(slide.config) : null}
    />
  )
}
