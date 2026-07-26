-- Lock down the live-session Realtime channel (security fix, /cso finding #1).
--
-- Session channels moved from PUBLIC to PRIVATE (lib/realtime/channels.ts). A public
-- channel accepts a broadcast from anyone holding the anon key — which is public by design
-- and ships in the client bundle — and the channel name contains only the 6-digit code the
-- host projects to the whole room. Any participant could therefore forge `slide:show` or
-- `slide:reveal` and control what every screen in the class displayed. (Verified: an
-- anon-key client published a forged reveal and a second client received it.)
--
-- Private channels authorize through RLS on realtime.messages, which Supabase ships with
-- RLS enabled and NO policies (deny-all). The policies below open exactly what the app
-- needs and nothing more:
--
--   * receive   — anyone may subscribe to a session topic. The room is joined by PIN, so
--                 slide content is not secret from participants; the answer key is withheld
--                 server-side until reveal, never by channel access.
--   * presence  — participants must write presence to appear in the host's lobby roster,
--                 so `extension = 'presence'` is the one write they keep.
--   * broadcast — NO insert policy, so anon/authenticated cannot publish events at all.
--                 The server publishes with the service-role key, which bypasses RLS
--                 (lib/realtime/broadcast.ts), so server → client events keep working.
--
-- realtime.topic() is the topic being joined or written; matching the `session:` prefix
-- keeps these policies scoped to this app's channels.

CREATE POLICY "session_channel_receive" ON realtime.messages
  FOR SELECT TO anon, authenticated
  USING ( realtime.topic() LIKE 'session:%' );
--> statement-breakpoint
CREATE POLICY "session_channel_presence_write" ON realtime.messages
  FOR INSERT TO anon, authenticated
  WITH CHECK ( realtime.topic() LIKE 'session:%' AND extension = 'presence' );
