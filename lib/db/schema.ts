import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

// App data for authenticated creators; `id` mirrors auth.users.id (Supabase Auth),
// row created on signup. RLS is ENABLED from creation (deny-all by default); the own-row
// read/update policy lands with auth in M2. Full design in docs/schema.md.
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // = auth.users.id
  email: text('email'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS()

// --- Live session tables (M1 spike) ---
// Only the service role touches these (it bypasses RLS); RLS is enabled with NO anon
// policies so a leaked anon key can't read/write them. See docs/schema.md.
// M1 runs a single hardcoded question, so there is no deck/slide/host FK yet:
//   ponytail: `host_token` stands in for host_id until M2 auth; `slide_id` is the
//   hardcoded question id (text, no FK) until the slides table lands in M3.

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    code: text('code').notNull(), // 6-digit PIN, unique among non-ended (index below)
    status: text('status').notNull().default('lobby'), // lobby | active | ended
    hostToken: text('host_token').notNull(), // server-issued; gates reveal/advance
    currentSlideIndex: integer('current_slide_index').notNull().default(-1), // -1 in lobby
    currentSlideStartedAt: timestamp('current_slide_started_at', { withTimezone: true }),
    // Live-broadcast bookkeeping: leaky-bucket throttle + last-broadcast top-N for deltas.
    lastBcast: timestamp('last_bcast', { withTimezone: true }),
    lastTopn: jsonb('last_topn').$type<{ participantId: string; rank: number }[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    // A code is reusable once a session ends; unique only among live sessions.
    uniqueIndex('sessions_active_code_idx').on(t.code).where(sql`${t.status} <> 'ended'`),
  ],
).enableRLS()

export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    nickname: text('nickname').notNull(),
    avatarSeed: text('avatar_seed').notNull(),
    clientToken: text('client_token').notNull(), // server-issued reconnect token
    score: integer('score').notNull().default(0),
    streak: integer('streak').notNull().default(0),
    joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('participants_session_token_idx').on(t.sessionId, t.clientToken)],
).enableRLS()

export const answers = pgTable(
  'answers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    slideId: text('slide_id').notNull(), // hardcoded question id in M1 (no FK yet)
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    response: jsonb('response').$type<{ optionId: string }>().notNull(),
    isCorrect: boolean('is_correct'), // null for non-quiz slides
    pointsAwarded: integer('points_awarded').notNull().default(0),
    responseMs: integer('response_ms').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    // One answer per participant per slide — the endpoint treats a conflict as "already answered".
    uniqueIndex('answers_unique_idx').on(t.sessionId, t.slideId, t.participantId),
    index('answers_session_slide_idx').on(t.sessionId, t.slideId), // aggregation scan
  ],
).enableRLS()
