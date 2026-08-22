import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_URL } from '@/lib/env'
import { serverEnv } from '@/lib/env.server'
import { openHostChannel, openSessionChannel } from './channels'
import type { EventName } from './events'

// Server → clients broadcast over Supabase Realtime via the REST endpoint (`httpSend`),
// so route handlers publish without opening a WebSocket (right primitive for serverless).
// The service-role key authorizes the publish — and on a PRIVATE channel it's the only
// thing that can: RLS on realtime.messages (migration 0005) denies broadcast writes to
// anon/authenticated, and the service role bypasses RLS. Without that, any participant
// could forge these events (the anon key is public), so the channel must stay private on
// both ends — httpSend only reaches private subscribers when the channel is opened private.

let client: SupabaseClient | null = null
function realtimeClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, serverEnv.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return client
}

// Best-effort, post-commit view hint: every caller (start/answer/reveal) has already
// committed its DB mutation before publishing, and clients reconcile through /state. So a
// Realtime delivery failure must NEVER propagate — otherwise a transient outage turns a
// committed session/answer/reveal into a 500 and the host loses its code/token. Log and
// swallow; never throw.
// ponytail: no durable retry in M1. Upgrade path — a transactional outbox drained by a
// worker — lands with the private-channel hardening in M8/M9 (docs/architecture.md).
export async function broadcast(code: string, event: EventName, payload: unknown): Promise<void> {
  return publish(openSessionChannel, code, event, payload)
}

/**
 * Publish to the host console alone (see `hostChannel`). For counters no participant renders:
 * on the room channel each one costs ~1 message per phone, here it costs 1 full stop.
 *
 * Separate function rather than a boolean argument, so the call site names its audience and
 * a reader of `answer/route.ts` can see which events the room is told about without going and
 * checking what `true` meant.
 */
export async function broadcastToHost(
  code: string,
  event: EventName,
  payload: unknown,
): Promise<void> {
  return publish(openHostChannel, code, event, payload)
}

async function publish(
  open: (c: SupabaseClient, code: string) => ReturnType<typeof openSessionChannel>,
  code: string,
  event: EventName,
  payload: unknown,
): Promise<void> {
  const supabase = realtimeClient()
  const channel = open(supabase, code)
  try {
    const res = await channel.httpSend(event, payload as object)
    if (!res.success) {
      console.error(`[broadcast] ${event} failed (${res.status}): ${res.error}`)
    }
  } catch (e) {
    console.error(`[broadcast] ${event} threw:`, e)
  } finally {
    // removeChannel() RESOLVES with 'ok' | 'timed out' | 'error' (it never rejects), and it only
    // tears the channel out of the shared client's registry when the leave acks 'ok'. On a
    // timed-out/errored leave we tear down locally — otherwise the singleton client accumulates
    // stale channels across every broadcast.
    const status = await supabase.removeChannel(channel).catch(() => 'error' as const)
    if (status !== 'ok') channel.teardown()
  }
}
