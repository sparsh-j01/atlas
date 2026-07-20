import 'server-only'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { serverEnv } from '@/lib/env'
import * as schema from './schema'

// App DB handle over Supabase's pooled connection (Supavisor, transaction mode).
// `prepare: false` is REQUIRED with the transaction pooler (no prepared statements).
// ponytail: DB is the scoring source of truth — fine at 100 players; upgrade path
// (in-memory room actor) noted in docs/architecture.md.
const client = postgres(serverEnv.databaseUrl, { prepare: false })

export const db = drizzle(client, { schema })
