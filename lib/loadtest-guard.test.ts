import { describe, expect, it } from 'vitest'
import { blocksRun, resolvePlan } from './loadtest-guard'

describe('resolvePlan', () => {
  it('defaults to free', () => expect(resolvePlan(undefined)).toEqual({ plan: 'free', limit: 200 }))
  it('reads pro', () => expect(resolvePlan('pro')).toEqual({ plan: 'pro', limit: 500 }))
  // A typo must not silently buy a higher ceiling, nor re-enable the override.
  it('falls back to free on an unknown name', () =>
    expect(resolvePlan('enterprise')).toEqual({ plan: 'free', limit: 200 }))
})

describe('blocksRun', () => {
  it('allows a 120-client run on free (121 connections, under 200)', () =>
    expect(blocksRun(121, 'free', false)).toBe(false))

  it('allows exactly the limit', () => expect(blocksRun(200, 'free', false)).toBe(false))

  it('blocks over the free limit', () => expect(blocksRun(201, 'free', false)).toBe(true))

  // The point of this module: no grace period is left, so the escape hatch is closed on free.
  it('blocks over the free limit EVEN WITH the override set', () =>
    expect(blocksRun(251, 'free', true)).toBe(true))

  it('lets the override through on pro, where an overage is a bill not an outage', () =>
    expect(blocksRun(501, 'pro', true)).toBe(false))

  it('still blocks pro without the override', () =>
    expect(blocksRun(501, 'pro', false)).toBe(true))
})
