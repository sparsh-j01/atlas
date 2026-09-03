# Atlas

A live, in-class quiz game where the questions come from **your own material**.
Upload a lecture PDF or describe a topic, and AI builds a complete, editable deck of
quiz questions and polls. Then run it live: students join from their phones with a
room code, answer in real time, and watch results and a competitive leaderboard
animate on the big screen.

Think Mentimeter's live visuals + Kahoot's competition, with an AI front door that
builds the whole assessment from your lecture material.

> Status: early development.

## What makes it different

Three things at once that nothing else combines:

- **Live, not a form.** 100+ students on the same question at the same instant — a
  synchronized room with a shared timer and a real-time leaderboard, not async
  submissions you grade later.
- **Grounded in your material.** Not generic internet questions — the deck is
  generated from the exact PDF or topic you give it, and you review and edit every
  question before it goes live.
- **Competitive and visual.** Speed-based scoring, an animated leaderboard, and live
  poll charts that fill in on screen as students respond.

## Highlights

- **Two ways in** — host a live class, or join one with a room code + nickname (no signup to play).
- **AI generation** — topic prompt or lecture PDF → a full, editable deck.
- **Built for scale** — designed for 100+ concurrent students per room, and exercised by a
  load-test harness that drives real Realtime connections rather than simulated ones.
- **Real-time everything** — synced questions, live-animating charts, a live leaderboard.
- **Slide types** — MCQ quiz (scored, with leaderboard) and poll (more to come).
- **Moderation** — nickname filtering and a host kick, because the room is on a projector.

## Stack

Next.js (App Router) + TypeScript · Supabase (Postgres, Realtime, Auth, Storage) ·
Claude API · Vercel.

## Development

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase project values
npm run dev                  # http://localhost:3000
```

Needs a Supabase project (Postgres + Realtime). Scripts: `dev`, `build`, `lint`,
`typecheck`, `test`, plus `db:generate` / `db:migrate` for schema changes.

## Auth setup

Teachers sign up with an email and password and cannot sign in until they click the
confirmation link; students never sign in at all. Two things live in the Supabase
dashboard rather than in this repo:

**Authentication → Providers → Email** — enable the provider and turn *Confirm email*
on. **Authentication → URL Configuration** — set the Site URL and add your dev and
production origins to the redirect allowlist (`http://localhost:3000/auth/callback` and
the deployed equivalent).

**Authentication → Providers → Google** — for "Continue with Google". Create an OAuth
client in the Google Cloud Console (APIs & Services → Credentials → OAuth client ID →
Web application) with this as the authorised redirect URI:

```
https://<YOUR-PROJECT-REF>.supabase.co/auth/v1/callback
```

That is Supabase's callback, not this app's. Paste the client ID and secret into the
Supabase dashboard; **the secret never belongs in this repo**. Supabase runs the OAuth
2.0 / OIDC exchange — it builds the authorization request, holds the secret, and
validates the ID token's signature, issuer, audience and nonce on its servers. This app
is the OAuth client *of Supabase*: `/auth/signin` starts the flow, `/auth/callback`
exchanges the returned code against a PKCE verifier held in an httpOnly cookie. There is
no token parsing or crypto in this codebase, and none should be added.

**Authentication → Email Templates** — point the two links at `/auth/confirm` so they
verify by token hash. Without this the default templates still work, but only in the
browser that requested them (they carry a PKCE code, and the verifier is a cookie in
that browser) — a teacher who signs up on a laptop and opens the mail on their phone
gets an error.

```html
<!-- Confirm signup -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup">Confirm your email</a>

<!-- Reset password -->
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password">Set a new password</a>
```

**Authentication → Emails → Email OTP Expiration** — set it to **900** seconds (15
minutes). The default is 3600. This is the lifetime of the `token_hash` in the two links
above, so it is the window a teacher has between asking for the mail and clicking it;
Supabase's own security advisor flags anything above an hour. It does not affect the
PKCE `code` that `/auth/callback` exchanges, which is separately short-lived and
single-use.

Supabase's built-in sender is capped at a couple of messages an hour and is not meant
for production; add your own SMTP under **Project Settings → Auth** before real users
arrive. Worth turning on while you are there: **leaked password protection**, which
checks new passwords against HaveIBeenPwned.

This app never sees a stored credential and does no hashing of its own — Supabase
bcrypts the password on its servers, and TLS covers it in transit. Hashing in the
browser would only make the hash the password.

Every auth call runs server-side in `lib/auth-actions.ts`, so the session cookie is
`httpOnly` + `Secure` (`lib/supabase/cookie-options.ts`) and no access or refresh token is
reachable from page JavaScript. `@supabase/ssr`'s own defaults are `httpOnly: false` with
no `Secure` at all, because its *browser* client needs to read the session back — nothing
here does, so both are closed. Those attributes are pinned by
`lib/supabase/cookie-options.test.ts`; if that test fails, the session became readable by
scripts again.

Input shapes — credentials, the `/auth/confirm` query parameters, and the `/auth/signin`
provider — are validated with zod in `lib/auth-validation.ts`; Supabase re-checks
everything regardless.

## License

TBD.
