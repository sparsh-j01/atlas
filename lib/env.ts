// Centralized env access (client-safe half).
// - Public vars (NEXT_PUBLIC_*) are read as literals so Next can inline them into
//   client bundles; safe to import anywhere — browser, server, and plain Node
//   (drizzle-kit imports `required` from here).
// - Server-only secrets live in ./env.server behind `import 'server-only'`, so this
//   file itself never poisons a client bundle. `required` is shared by both.
// ponytail: hand-rolled guard, not zod — a few lines, and there's no other
// schema-validation need yet. Reach for zod only if env grows.

export function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required env var: ${name}`)
  return value
}

// Public — safe in the browser. Literal form (not a getter) so Next statically
// inlines them client-side. Empty-string fallback keeps import + `next build`
// safe when unset (CI builds without secrets); a missing value surfaces at the
// Supabase client call, not here.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
