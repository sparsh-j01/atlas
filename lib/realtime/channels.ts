import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js'

// Realtime channel naming + construction. One channel per live session, keyed by the
// 6-digit code. Spec: docs/schema.md → "Realtime contracts".
export const sessionChannel = (code: string) => `session:${code}`

/**
 * The presenter's own channel: live counters that ONLY the host screen renders.
 *
 * Why two channels rather than one. Supabase counts and bills Realtime per *delivered copy*,
 * so a broadcast to a 100-phone room is ~101 messages, not 1. `answered:count` and
 * `results:update` fire repeatedly while a question is open and no participant reads either —
 * `app/play/page.tsx` has no handler for them. Sending them room-wide meant 100 phones
 * downloading, decoding and discarding two events a second. On here they cost 2 messages
 * instead of 102, which is most of this app's message bill.
 *
 * Everything the ROOM needs — slide:show, slide:reveal, leaderboard:update, session:ended,
 * participant:kicked — stays on sessionChannel(). The split is by audience, not importance.
 *
 * Kept under the `session:` prefix on purpose: migration 0005's RLS policies match
 * `realtime.topic() LIKE 'session:%'`, so this topic inherits them with no migration —
 * everyone may receive, only the service role may broadcast. Nothing here is secret anyway:
 * an answered count is already projected on the wall, and `results:update` only ever fires
 * for a poll, whose distribution is public by design. A scored quiz never sends it (see
 * isScored), so the anti-herding rule doesn't depend on channel access.
 */
export const hostChannel = (code: string) => `session:${code}:host`

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

/** Same construction rules as above (private, or the topic silently differs). Opened by the
 *  host console and by the server when it publishes a host-only counter. */
export function openHostChannel(supabase: SupabaseClient, code: string): RealtimeChannel {
  return supabase.channel(hostChannel(code), { config: { private: true } })
}
