import 'server-only'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { SUPABASE_URL } from '@/lib/env'
import { serverEnv } from '@/lib/env.server'
import { sessionChannel } from './channels'
import type { EventName } from './events'

// Server → clients broadcast over Supabase Realtime via the REST endpoint (`httpSend`),
// so route handlers publish without opening a WebSocket (right primitive for serverless).
// The service-role key authorizes the publish.
// ponytail: channels are public in M1 — broadcasts are view hints, all authority is the
// HTTP endpoints. Lock to private channels + RLS on realtime.messages in M8/M9 so clients
// can't spoof broadcasts.

let client: SupabaseClient | null = null
function realtimeClient(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, serverEnv.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  }
  return client
}

export async function broadcast(code: string, event: EventName, payload: unknown): Promise<void> {
  const supabase = realtimeClient()
  const channel = supabase.channel(sessionChannel(code))
  try {
    const res = await channel.httpSend(event, payload as object)
    if (!res.success) {
      throw new Error(`broadcast ${event} failed (${res.status}): ${res.error}`)
    }
  } finally {
    await supabase.removeChannel(channel)
  }
}
