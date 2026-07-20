import { config } from 'dotenv'
import { defineConfig } from 'drizzle-kit'

// Migrations run against the DIRECT (session-mode, 5432) connection, not the pooler.
// Load .env.local for local runs; in CI the vars come from the environment already.
config({ path: '.env.local' })

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DIRECT_URL!,
  },
})
