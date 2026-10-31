# Atlas

A live, in-class quiz game where the questions come from **your own material**.
Upload your lecture files or describe a topic, and AI builds a complete, editable deck of
quiz questions. Then run it live: students join from their phones with a room code,
answer in real time, and watch a competitive leaderboard update on the big screen.

Think Kahoot's competition, with an AI front door that builds the whole assessment
from your lecture material.

> Status: working prototype, feature-complete for now (October 2026). It has not been
> used with a real class yet.

## What makes it different

Three things at once that nothing else combines:

- **Live, not a form.** 100+ students on the same question at the same instant — a
  synchronized room with a shared timer and a real-time leaderboard, not async
  submissions you grade later.
- **Grounded in your material.** Not generic internet questions — the deck is
  generated from the exact PDF or topic you give it, and you review and edit every
  question before it goes live.
- **Competitive.** Speed-based scoring and a leaderboard that re-ranks after every
  question.

## Highlights

- **Two ways in** — host a live class, or join one with a room code + nickname (no signup to play).
- **AI generation** — a topic prompt, or up to five PDF or PowerPoint files, becomes a full,
  editable deck. Questions are written from passages retrieved from your files, checked
  against that source by a second model call, and saved with a link to the passage they came
  from. Image-only slides are read with OCR; fully scanned PDFs are turned away.
- **Built for scale** — designed for 100+ concurrent students per room, and exercised by a
  load-test harness that drives real Realtime connections rather than simulated ones.
- **Real-time everything** — synced questions, a shared timer, a live leaderboard.
- **Automatic classroom flow** — start once; each timer moves the whole class to the next
  question. The teacher sees ranked names and scores, updated after each question.
- **Review and lecture planning** — students review their answers and explanations after
  the quiz; teachers see class patterns and individual performance with follow-up suggestions.
- **Questions** — multiple choice, scored on correctness and speed.
- **Moderation** — nickname filtering and a host kick, because the room is on a projector.

## How the AI part was tested

The retrieval and generation pipeline was benchmarked on 50 labelled requests over three
OpenStax textbook sections (about 131k tokens in total). Vector and hybrid search both found
the labelled evidence in the top 8 results for all 40 answerable requests; hybrid did not
rank it any earlier than vector alone. With the same model and requests, the retrieval
pipeline produced an accepted question for 40/40 answerable requests, against 38/40 when the
whole document was sent instead, and used 92% fewer input tokens. Both versions held back a
question for 9 of the 10 requests the source could not answer, but only the retrieval
version did so by recognising the answer was missing (8 of 10); the whole-document version
wrote an off-topic question each time and was caught by the checker.

That is a small benchmark with AI-assisted labels and a model-based judge, so treat it as a
check on this pipeline, not a general accuracy figure. The harness is in `evals/`.

## Stack

Next.js 16 (App Router) + React 19 + TypeScript · Tailwind v4 · Supabase (Postgres with
pgvector, Realtime, Auth, Storage) · Drizzle · Gemini (generation and embeddings) · Vercel.

## Development

```bash
npm install
cp .env.example .env.local   # then fill in the values below
npm run db:migrate           # apply the schema to your Supabase database
npm run dev                  # http://localhost:3000
```

`.env.example` documents each variable. The ones you need:

- **Supabase** — `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (pooled) and `DIRECT_URL` (direct, used by
  migrations).
- **AI** — `GEMINI_API_KEY`. `AI_MONTHLY_BUDGET_USD` (default 5) is a hard monthly cap on
  AI spend across the whole app; once it is reached, generation is refused until the next
  month or until you raise it.
- **Optional** — `CRON_SECRET` for the daily cleanup of abandoned uploads (scheduled in
  `vercel.json`), `ALERT_WEBHOOK_URL` for spend alerts, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`
  for a bot check on sign-in.

Scripts: `dev`, `build`, `lint`, `typecheck`, `test`, `db:generate` / `db:migrate` for
schema changes, `smoke` (walks a full live session against a running dev server),
`loadtest` (simulated students over real Realtime connections) and `eval:*` for the
benchmarks.

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
