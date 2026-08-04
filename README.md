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
- **Built for scale** — designed for 100+ concurrent students per room, proven by a
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

## License

TBD.
