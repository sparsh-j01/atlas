import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

// The auth actions are the one place the brief's "5 per 15 minutes per IP and per email" lands,
// and the refusal has two jobs: stop BEFORE Supabase is called (each call can send an email
// from a project-wide allowance of two an hour), and say the same thing whether or not the
// address has an account.

const refused = new Set<string>()
const seen: { name: string; subject: string }[] = []

vi.mock('next/headers', () => ({
  headers: async () => new Headers({ 'x-forwarded-for': '203.0.113.9', origin: 'https://atlas.test' }),
}))
vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkLimit: async (name: string, subject: string) => {
    seen.push({ name, subject })
    return refused.has(name) ? { ok: false, retryAfterSec: 600 } : { ok: true }
  },
}))
const auth = {
  signUp: vi.fn(async () => ({ error: null })),
  signInWithPassword: vi.fn(async () => ({ error: null })),
  resend: vi.fn(async () => ({})),
  resetPasswordForEmail: vi.fn(async () => ({})),
}
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth }) }))

const { signInAction, signUpAction, resendConfirmationAction, requestPasswordResetAction } =
  await import('../auth-actions')

const form = (email: string) => {
  const f = new FormData()
  f.set('email', email)
  f.set('password', 'correct horse battery staple')
  return f
}

beforeEach(() => {
  refused.clear()
  seen.length = 0
  Object.values(auth).forEach((fn) => fn.mockClear())
})

describe('auth actions are limited before Supabase is called', () => {
  it('sign-in: per IP and per (normalised) email', async () => {
    await signInAction(form('Teacher@School.example'))
    expect(seen).toEqual([
      { name: 'authPerIp', subject: '203.0.113.9' },
      { name: 'signInPerEmail', subject: 'teacher@school.example' },
    ])
  })

  it('sign-in over the per-email limit: refused with a wait, Supabase never called', async () => {
    refused.add('signInPerEmail')
    expect(await signInAction(form('a@b.example'))).toEqual({ error: 'Too many attempts. Try again in 10 minutes.' })
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })

  it('every email-sending action stops at the per-address limit without sending', async () => {
    refused.add('emailPerAddress')
    for (const r of [
      await signUpAction(form('a@b.example')),
      await resendConfirmationAction('a@b.example', '/dashboard'),
      await requestPasswordResetAction('a@b.example'),
    ])
      expect(r).toEqual({ error: 'Too many attempts. Try again in 10 minutes.' })
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(auth.resend).not.toHaveBeenCalled()
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled()
  })

  it('the per-IP limit stops all of them too', async () => {
    refused.add('authPerIp')
    expect((await signInAction(form('a@b.example'))).error).toMatch(/Too many attempts/)
    expect((await requestPasswordResetAction('a@b.example')).error).toMatch(/Too many attempts/)
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
    expect(auth.resetPasswordForEmail).not.toHaveBeenCalled()
  })
})
