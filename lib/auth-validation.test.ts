import { describe, expect, it } from 'vitest'
import {
  confirmParamsSchema,
  nextPathSchema,
  oauthSignInParamsSchema,
  signInSchema,
  signUpSchema,
} from './auth-validation'

describe('nextPathSchema', () => {
  it('keeps same-origin paths', () => {
    expect(nextPathSchema.parse('/dashboard')).toBe('/dashboard')
    expect(nextPathSchema.parse('/decks/abc/edit')).toBe('/decks/abc/edit')
  })

  // The whole point of the schema: each of these reads as relative and is not.
  it.each(['//evil.example', '/\\evil.example', 'https://evil.example', 'dashboard', ''])(
    'falls back to the dashboard for %j',
    (value) => {
      expect(nextPathSchema.parse(value)).toBe('/dashboard')
    },
  )

  it('falls back when the parameter is missing entirely', () => {
    expect(nextPathSchema.parse(undefined)).toBe('/dashboard')
  })
})

describe('confirmParamsSchema', () => {
  const valid = { token_hash: 'abc123', type: 'signup', next: '/dashboard' }

  it('accepts a well-formed link', () => {
    expect(confirmParamsSchema.parse(valid)).toEqual(valid)
  })

  it('rejects a type that is not one verifyOtp knows', () => {
    expect(confirmParamsSchema.safeParse({ ...valid, type: 'admin' }).success).toBe(false)
  })

  it('rejects an empty or oversized token', () => {
    expect(confirmParamsSchema.safeParse({ ...valid, token_hash: '' }).success).toBe(false)
    expect(confirmParamsSchema.safeParse({ ...valid, token_hash: 'x'.repeat(513) }).success).toBe(false)
  })

  it('sanitises next rather than failing the whole link', () => {
    expect(confirmParamsSchema.parse({ ...valid, next: '//evil.example' }).next).toBe('/dashboard')
  })
})

describe('credentials', () => {
  it('trims the email and requires a real one', () => {
    expect(signInSchema.parse({ email: '  teacher@uni.edu ', password: 'x' }).email).toBe(
      'teacher@uni.edu',
    )
    expect(signInSchema.safeParse({ email: 'teacher@', password: 'x' }).success).toBe(false)
  })

  it('holds new passwords to 8..72 but lets an existing short one sign in', () => {
    expect(signUpSchema.safeParse({ email: 'a@b.co', password: 'short12' }).success).toBe(false)
    expect(signUpSchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(73) }).success).toBe(false)
    expect(signUpSchema.safeParse({ email: 'a@b.co', password: 'longenough' }).success).toBe(true)
    expect(signInSchema.safeParse({ email: 'a@b.co', password: 'short1' }).success).toBe(true)
  })
})

describe('oauthSignInParamsSchema', () => {
  it('accepts the one provider this app offers', () => {
    expect(oauthSignInParamsSchema.parse({ provider: 'google', next: '/dashboard' })).toEqual({
      provider: 'google',
      next: '/dashboard',
    })
  })

  // The value reaches signInWithOAuth and from there the authorize URL. Anything the
  // Supabase project has ever had configured would otherwise be reachable from our button.
  it.each(['github', 'azure', 'apple', '', 'GOOGLE', 'google '])(
    'rejects %j as a provider',
    (provider) => {
      expect(oauthSignInParamsSchema.safeParse({ provider, next: '/dashboard' }).success).toBe(
        false,
      )
    },
  )

  it('rejects a missing provider rather than defaulting to one', () => {
    expect(oauthSignInParamsSchema.safeParse({ next: '/dashboard' }).success).toBe(false)
  })

  // An OAuth return leg is the highest-value open redirect in the app: the victim has just
  // authenticated, so a bounce off-origin lands them on a phishing page mid-login.
  it.each(['//evil.example', '/\\evil.example', 'https://evil.example'])(
    'sanitises the post-login redirect %j',
    (next) => {
      expect(oauthSignInParamsSchema.parse({ provider: 'google', next }).next).toBe('/dashboard')
    },
  )
})
