import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_COOKIE_OPTIONS } from './cookie-options'

/**
 * These four attributes are the whole reason lib/auth-actions.ts exists. @supabase/ssr
 * ships `httpOnly: false` and no `secure` at all, so if this object is ever dropped or
 * softened the session silently goes back to being readable by page scripts — with nothing
 * failing and nothing to see in a diff review. That is what this file is for.
 */
describe('SESSION_COOKIE_OPTIONS', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('keeps the access and refresh token out of reach of page JS', () => {
    expect(SESSION_COOKIE_OPTIONS.httpOnly).toBe(true)
  })

  it('scopes to the whole origin, since the gate covers /dashboard and /decks', () => {
    expect(SESSION_COOKIE_OPTIONS.path).toBe('/')
  })

  // Not 'strict': the return leg of a social sign-in is a top-level cross-site GET from the
  // provider, and Strict would withhold the PKCE verifier on exactly that request.
  it('stays lax so the OAuth return leg still carries it', () => {
    expect(SESSION_COOKIE_OPTIONS.sameSite).toBe('lax')
  })

  it('sets Secure in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.resetModules()
    const { SESSION_COOKIE_OPTIONS: prod } = await import('./cookie-options')
    expect(prod.secure).toBe(true)
  })

  // Conditional rather than a literal `true`, or http://localhost drops the cookie and
  // nobody can sign in locally.
  it('leaves Secure off outside production so localhost still works', async () => {
    vi.stubEnv('NODE_ENV', 'development')
    vi.resetModules()
    const { SESSION_COOKIE_OPTIONS: dev } = await import('./cookie-options')
    expect(dev.secure).toBe(false)
  })
})
