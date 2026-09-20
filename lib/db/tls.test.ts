import { afterEach, describe, expect, it } from 'vitest'
import { databaseTls } from './tls'

// Supabase's chain ends in its own root, so verifying without that root fails every
// connection (SELF_SIGNED_CERT_IN_CHAIN, checked 2026-10-05); and no TLS option at all was
// plaintext. Encrypt always; verify once the CA is configured.
describe('databaseTls', () => {
  afterEach(() => { delete process.env.DATABASE_CA_CERT })

  it('encrypts without verifying when no CA is configured', () => {
    expect(databaseTls()).toBe('require')
  })

  it('verifies against the configured CA, unescaping \\n', () => {
    process.env.DATABASE_CA_CERT = '-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----'
    expect(databaseTls()).toEqual({ rejectUnauthorized: true, ca: '-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----' })
  })
})
