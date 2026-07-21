import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

// App data for authenticated creators; `id` mirrors auth.users.id (Supabase Auth),
// row created on signup. RLS is ENABLED from creation (deny-all by default); the own-row
// read/update policy lands with auth in M2. Other tables — decks, slides, sessions,
// participants, answers — land in M2/M3 when first used; full design in docs/schema.md.
export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // = auth.users.id
  email: text('email'),
  displayName: text('display_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}).enableRLS()
