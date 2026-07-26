import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

// Realtime channel naming + construction. One channel per live session, keyed by the
// 6-digit code. Spec: docs/schema.md → "Realtime contracts".
export const sessionChannel = (code: string) => `session:${code}`

/**
 * Open the session channel. Every participant, the host console, the load-test harness and
 * the server publisher must open it the SAME way — `private: true` — because a private and
 * a public channel of the same name are different topics: a caller that forgets the flag
 * silently stops receiving. That's why construction lives here, not at each call site.
 *
 * Private is what makes the channel trustworthy. A public channel accepts a broadcast from
 * anyone holding the anon key — which is public by design and ships in the client bundle —
 * so any participant could forge `slide:show` / `slide:reveal` and drive what the whole room
 * sees. Private channels route authorization through RLS on `realtime.messages`
 * (migration 0005): everyone may receive, participants may write presence only, and
 * broadcasts belong to the service role alone.
 */
export function openSessionChannel(supabase: SupabaseClient, code: string): RealtimeChannel {
  return supabase.channel(sessionChannel(code), { config: { private: true } })
}
