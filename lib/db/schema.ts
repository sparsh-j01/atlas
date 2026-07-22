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
// Slide config shape lives in the pure lib/mcq module (shared with the client editor),
// so schema.ts stays the single place columns are declared without duplicating the type.
import type { SlideConfig } from '@/lib/mcq'

// App data for authenticated creators; `id` mirrors auth.users.id (Supabase Auth),
// row created on signup. RLS is ENABLED from creation (deny-all by default); the own-row
// read/update policy lands with auth in M2. Full design in docs/schema.md.
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // = auth.users.id
  email: text('email'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS()

// --- Creator content (M2): decks + slides, owner-isolated. RLS is enabled here; the
// owner-only policies + the signup trigger that seeds `profiles` live in the migration
// SQL (Drizzle can't express policies/triggers). App access is Drizzle scoped by
// owner_id (see lib/decks.ts); the policies are defense-in-depth on the anon-key path.

export const decks = pgTable('decks', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  status: text('status').notNull().default('draft'), // draft | ready
  sourceType: text('source_type').notNull().default('manual'), // manual | topic | pdf
  sourceRef: text('source_ref'), // topic string or Storage path (AI paths land in M6/M7)
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS()

export const slides = pgTable(
  'slides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(), // 0-based order within the deck
    type: text('type').notNull(), // quiz_mcq (M2) | poll | word_cloud | ... (M5+)
    prompt: text('prompt').notNull(),
    config: jsonb('config').$type<SlideConfig>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // No unique index on (deck_id, position) here: the migration adds it as a DEFERRABLE
  // constraint so a full-list reorder can rewrite every position in one transaction
  // (checked at commit) without transient-collision errors. See lib/decks.ts reorder.
).enableRLS()

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
    status: text('status').notNull().default('lobby'), // lobby | active | revealed | ended
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
