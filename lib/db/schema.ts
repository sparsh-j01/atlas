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
  vector,
  real,
} from 'drizzle-orm/pg-core'
import { sql, type InferSelectModel } from 'drizzle-orm'
// Slide config shape lives in the pure lib/slides module (shared with the client editor),
// so schema.ts stays the single place columns are declared without duplicating the type.
import type { SlideConfig } from '@/lib/slides'

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

export const decks = pgTable(
  'decks',
  {
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
  },
  // Every deck query filters by owner_id (see lib/decks.ts) and it's the profile-delete
  // cascade target — index it.
  (t) => [index('decks_owner_id_idx').on(t.ownerId)],
).enableRLS()

export const slides = pgTable(
  'slides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deckId: uuid('deck_id')
      .notNull()
      .references(() => decks.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(), // 0-based order within the deck
    type: text('type').notNull(), // quiz_mcq (M2) | poll (M5) — see SLIDE_TYPES in lib/slides.ts
    prompt: text('prompt').notNull(),
    config: jsonb('config').$type<SlideConfig>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  // No unique index on (deck_id, position) here: the migration adds it as a DEFERRABLE
  // constraint so a full-list reorder can rewrite every position in one transaction
  // (checked at commit) without transient-collision errors. See lib/decks.ts reorder.
).enableRLS()

// --- Live session tables ---
// Only the service role touches these (it bypasses RLS); RLS is enabled with NO anon
// policies so a leaked anon key can't read/write them. See docs/schema.md.
// A session is a live run of one deck by one creator. `answers.slide_id` holds the slide's
// uuid as text with no FK: answers outlive the slide they were given for, so a later edit
// or deck delete can't cascade away a finished game's record.

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Both are always set at launch (lib/sessions.ts is the only writer). Nullable anyway:
    // `deck_id` has to be, for ON DELETE SET NULL — deleting a deck keeps its finished
    // sessions as history instead of erasing them. `host_id` cascades (losing the creator
    // takes their sessions) and stays nullable only so pre-M3 spike rows still load.
    deckId: uuid('deck_id').references(() => decks.id, { onDelete: 'set null' }),
    hostId: uuid('host_id').references(() => profiles.id, { onDelete: 'cascade' }),
    code: text('code').notNull(), // 6-digit PIN, unique among non-ended (index below)
    status: text('status').notNull().default('lobby'), // lobby | active | revealed | ended
    hostToken: text('host_token').notNull(), // server-issued; gates reveal/advance
    currentSlideIndex: integer('current_slide_index').notNull().default(-1), // -1 in lobby
    currentSlideStartedAt: timestamp('current_slide_started_at', { withTimezone: true }),
    // Slides whose answer key has already gone out to the room. Re-showing one must NOT
    // reopen scoring: the correct option is public by then, so anyone who sat the question
    // out could submit it for full points. advance/ consults this to re-show a revealed
    // slide in its revealed state instead of flipping the session back to 'active'.
    revealedSlideIds: jsonb('revealed_slide_ids').$type<string[]>().notNull().default([]),
    // Live-broadcast bookkeeping: leaky-bucket throttle + last-broadcast top-N for deltas.
    lastBcast: timestamp('last_bcast', { withTimezone: true }),
    lastTopn: jsonb('last_topn').$type<{ participantId: string; rank: number }[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
  },
  (t) => [
    // A code is reusable once a session ends; unique only among live sessions.
    uniqueIndex('sessions_active_code_idx').on(t.code).where(sql`${t.status} <> 'ended'`),
    // One live room per deck. Without this, a double-clicked Present opens a second session
    // on the same deck: two codes, two rosters, and ending one leaves the deck still locked
    // by the other. lib/sessions.ts resumes the existing room rather than surfacing this.
    uniqueIndex('sessions_active_deck_idx').on(t.deckId).where(sql`${t.status} <> 'ended'`),
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

// --- M7 RAG tables ---
// Document ingestion + structure-aware chunking + embeddings + evidence spans.
// All RLS enabled, service-role only (no anon policies). Owner isolation via documents.owner_id.

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => profiles.id, { onDelete: 'cascade' }),
    deckId: uuid('deck_id').references(() => decks.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    sourceType: text('source_type').notNull(),
    status: text('status').notNull().default('uploaded'),
    fileSize: integer('file_size').notNull(),
    pageCount: integer('page_count').notNull(),
    contentHash: text('content_hash').notNull(),
    storagePath: text('storage_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('documents_owner_id_idx').on(t.ownerId), index('documents_deck_id_idx').on(t.deckId)],
).enableRLS()

export const documentPages = pgTable(
  'document_pages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    // The immutable extracted source. Nothing rewrites this — structure detection returns
    // offsets into it and the chunker slices it. See lib/ai/structure.ts.
    rawText: text('raw_text').notNull(),
    // Text OCR recovered from this page's images, kept SEPARATE from raw_text rather than
    // merged into it. raw_text is what the file actually contained; ocr_text is a machine's
    // reading of a picture, and the two have different reliability. Keeping them apart also
    // means re-running OCR never rewrites the digital text, and a page with NULL here joins
    // to byte-identical document text — which is what makes the PDF path provably unchanged.
    ocrText: text('ocr_text'),
    // digital | ocr | mixed — where this page's text came from, for the UI and for anyone
    // reading a citation later.
    textSource: text('text_source').notNull().default('digital'),
    // Why this page produced no text: parse_error | empty | image_only. NULL when it did.
    // Recorded rather than dropped — see lib/ingest/coverage.ts.
    unreadReason: text('unread_reason'),
  },
  (t) => [uniqueIndex('document_pages_doc_page_idx').on(t.documentId, t.pageNumber)],
).enableRLS()

// Images embedded in a source document, recorded so the OCR stage knows what to read.
//
// The BYTES ARE NOT COPIED HERE. `entry_path` points at the file inside the already-stored
// .pptx, so there is one object per upload rather than one per image: deletion still
// cascades from the document row, there is no second storage lifetime to get wrong, and no
// second place a tenant boundary has to be enforced. Reading an image means opening the
// .pptx the owner already uploaded, which is a check that already exists.
export const documentAssets = pgTable(
  'document_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    pageNumber: integer('page_number').notNull(),
    /** Position within the page, so two images on one slide stay distinguishable. */
    assetIndex: integer('asset_index').notNull(),
    /** Path INSIDE the stored source file, e.g. "ppt/media/image3.png". */
    entryPath: text('entry_path').notNull(),
    mimeType: text('mime_type').notNull(),
    /** pending | done | skipped | failed. `skipped` is a format OCR cannot read. */
    ocrStatus: text('ocr_status').notNull().default('pending'),
    ocrText: text('ocr_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('document_assets_doc_page_index_idx').on(t.documentId, t.pageNumber, t.assetIndex),
    index('document_assets_doc_status_idx').on(t.documentId, t.ocrStatus),
  ],
).enableRLS()

export const documentSections = pgTable(
  'document_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    heading: text('heading').notNull(),
    pageStart: integer('page_start').notNull(),
    pageEnd: integer('page_end').notNull(),
    startOffset: integer('start_offset').notNull(),
    endOffset: integer('end_offset').notNull(),
  },
  (t) => [uniqueIndex('document_sections_doc_offset_idx').on(t.documentId, t.startOffset)],
).enableRLS()

export const chunks = pgTable(
  'chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => documentSections.id, { onDelete: 'cascade' }),
    chunkIndex: integer('chunk_index').notNull(),
    pageStart: integer('page_start').notNull(),
    pageEnd: integer('page_end').notNull(),
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    text: text('text').notNull(),
    tokenCount: integer('token_count').notNull(),
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('chunks_doc_idx_idx').on(t.documentId, t.chunkIndex),
    index('chunks_section_id_idx').on(t.sectionId),
  ],
).enableRLS()

export const embeddings = pgTable(
  'embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    // provider/model/version/dimension travel WITH the vector so two embedding
    // populations can never be silently compared. Re-embedding after a model change
    // writes new rows under a new version rather than overwriting — the unique index
    // below is what keeps both generations addressable during the migration.
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    version: text('version').notNull(),
    dimension: integer('dimension').notNull(),
    // MUST match EMBEDDING_DIMENSION in lib/ai/embed.ts. pgvector fixes the width at the
    // column, so a mismatch is not a degraded result, it is a failed INSERT on every
    // chunk. This read 384 while the embedder emitted 768, which is why nothing ever
    // reached the `ready` state.
    vector: vector('vector', { dimensions: 768 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('embeddings_chunk_provider_model_version_idx').on(t.chunkId, t.provider, t.model, t.version)],
  // NO vector index, deliberately (plan decision D1). Retrieval is scoped to one document
  // — a few hundred chunks — where an exact scan is microseconds and cannot miss. HNSW is
  // approximate, so it can walk past the best passage, and every query here filters by
  // document_id, which is precisely where post-filtering an ANN index falls down (ask for
  // 20 neighbours, get 3 back after the filter). Add one only when a measurement says the
  // scan is too slow, which needs a corpus far larger than one lecture.
).enableRLS()

export const generationSources = pgTable(
  'generation_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Cascades with the slide. Without the FK, deleting a deck left its citation rows
    // behind forever, pointing at slides that no longer exist.
    generatedSlideId: uuid('generated_slide_id')
      .notNull()
      .references(() => slides.id, { onDelete: 'cascade' }),
    chunkId: uuid('chunk_id')
      .notNull()
      .references(() => chunks.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    page: integer('page').notNull(),
    section: text('section').notNull(),
    charStart: integer('char_start').notNull(),
    charEnd: integer('char_end').notNull(),
    supportScore: real('support_score'),
  },
  (t) => [index('generation_sources_slide_idx').on(t.generatedSlideId)],
).enableRLS()

export const ingestionJobs = pgTable(
  'ingestion_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    status: text('status').notNull(),
    attempt: integer('attempt').notNull().default(1),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('ingestion_jobs_doc_status_idx').on(t.documentId, t.status)],
).enableRLS()

export type Document = InferSelectModel<typeof documents>
export type IngestionJob = InferSelectModel<typeof ingestionJobs>
export type DocumentPage = InferSelectModel<typeof documentPages>
export type DocumentAsset = InferSelectModel<typeof documentAssets>
export type DocumentSection = InferSelectModel<typeof documentSections>
export type Chunk = InferSelectModel<typeof chunks>
export type Embedding = InferSelectModel<typeof embeddings>
export type GenerationSource = InferSelectModel<typeof generationSources>
