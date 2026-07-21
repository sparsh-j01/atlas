import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'
import { required } from './lib/env'

// Migrations run against the DIRECT (session-mode, 5432) connection, not the pooler.
// Load .env.local for local runs; in CI the vars come from the environment already.
config({ path: '.env.local' })

// `required` (not `process.env.DIRECT_URL!`) so a missing var fails with a clear
// message instead of a cryptic connection error. Imported from ./lib/env, which is
// client-safe / server-only-free — drizzle-kit runs in plain Node, where a
// `server-only` module would throw.
export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: required('DIRECT_URL'),
  },
})
