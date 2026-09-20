import type { ConnectionOptions } from 'node:tls'

/**
 * TLS for every Postgres connection. Neither connection string carries `sslmode`, and
 * postgres.js defaults to `ssl: false`, so without this the app talked to Supabase in
 * plaintext (checked 2026-10-05).
 *
 * Supabase's certificates chain to Supabase's own root, not a public one, so full
 * verification needs that root: Dashboard → Database → SSL Configuration → download, then
 * set DATABASE_CA_CERT (PEM; `\n` escapes allowed). Verifying against the system store
 * instead fails every connection with SELF_SIGNED_CERT_IN_CHAIN.
 * ponytail: encrypt-only (`require`) until the CA is set; set it on Vercel for verify-full.
 */
export function databaseTls(): ConnectionOptions | 'require' {
  const ca = process.env.DATABASE_CA_CERT?.replaceAll('\\n', '\n').trim()
  return ca ? { rejectUnauthorized: true, ca } : 'require'
}

/** Drizzle Kit accepts structured credentials without URL sslmode overriding TLS. */
export function migrationCredentials(connectionString: string) {
  const url = new URL(connectionString)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database URL protocol')
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: databaseTls(),
  }
}
