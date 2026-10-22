import { cookies, headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { getHostedSession } from '@/lib/sessions'
import { readProgressState } from '@/lib/realtime/session-progress'
import { HostConsole } from '@/components/HostConsole'

export async function generateMetadata({ params }: { params: Promise<{ code: string }> }) {
  return { title: `Room ${(await params).code}` }
}

export default async function HostSessionPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params
  const session = await getHostedSession(code, (await cookies()).get(`htk_${code}`)?.value ?? '', true)
  if (!session) notFound()
  return <HostConsole code={session.code} sessionId={session.id}
    joinHost={(await headers()).get('host') ?? ''} initialState={await readProgressState(session)} />
}
