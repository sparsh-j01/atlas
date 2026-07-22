import 'server-only'
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { serverEnv } from '@/lib/env.server'
import * as schema from './schema'

type DB = PostgresJsDatabase<typeof schema>

// App DB handle over Supabase's pooled connection (Supavisor, transaction mode).
// `prepare: false` is REQUIRED with the transaction pooler (no prepared statements).
//
// Constructed LAZILY on first query — not at import. `next build` imports route modules to
// collect metadata but never runs a query, and CI builds with no secrets; an import-time
// `postgres(serverEnv.databaseUrl)` would read DATABASE_URL and fail the build. The Proxy
// defers that read until a real call site touches `db`.
// ponytail: DB is the scoring source of truth — fine at 100 players; upgrade path
// (in-memory room actor) noted in docs/architecture.md.
let instance: DB | null = null
function connect(): DB {
  if (!instance) {
    const client = postgres(serverEnv.databaseUrl, { prepare: false })
    instance = drizzle(client, { schema })
  }
  return instance
}

export const db = new Proxy({} as DB, {
  get(_target, prop, receiver) {
    const real = connect() as unknown as Record<string | symbol, unknown>
    const value = Reflect.get(real, prop, receiver)
    return typeof value === 'function' ? value.bind(real) : value
  },
})
