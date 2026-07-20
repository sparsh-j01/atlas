// Centralized env access.
// - Public vars (NEXT_PUBLIC_*) are read as literals so Next can inline them into
//   client bundles; safe to import anywhere.
// - Server-only secrets are validated lazily (getter throws on use, not at import),
//   so a missing var fails loudly at the call site instead of silently at build.
// ponytail: hand-rolled guard, not zod — three lines, and there's no other
// schema-validation need yet. Reach for zod only if env grows.

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

// Public — safe in the browser.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

// Server-only. These getters just turn a missing var into an obvious error; the
// values are never in the client bundle regardless (non-NEXT_PUBLIC vars are undefined
// client-side).
export const serverEnv = {
  get serviceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY')
  },
  get databaseUrl() {
    return required('DATABASE_URL')
  },
  get directUrl() {
    return required('DIRECT_URL')
  },
}
