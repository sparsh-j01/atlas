import { describe, it, expect } from 'vitest'
import { tallyMcq, rankLeaderboard, resolveRoster } from './aggregate'

describe('tallyMcq', () => {
  it('counts per option and totals', () => {
    const agg = tallyMcq([{ optionId: 'a' }, { optionId: 'b' }, { optionId: 'a' }])
    expect(agg).toEqual({ counts: { a: 2, b: 1 }, total: 3 })
  })
  it('is empty for no answers', () => {
    expect(tallyMcq([])).toEqual({ counts: {}, total: 0 })
  })
})

describe('rankLeaderboard', () => {
  const p = (id: string, score: number) => ({ participantId: id, nickname: id, avatarSeed: id, score })

  it('sorts by score desc and assigns ranks 1..N', () => {
    const top = rankLeaderboard([p('a', 100), p('b', 300), p('c', 200)], null)
    expect(top.map((e) => [e.participantId, e.rank])).toEqual([['b', 1], ['c', 2], ['a', 3]])
  })

  it('breaks ties deterministically by participantId', () => {
    const top = rankLeaderboard([p('z', 100), p('a', 100)], null)
    expect(top.map((e) => e.participantId)).toEqual(['a', 'z'])
  })

  it('computes delta vs the last broadcast top-N (positive = moved up)', () => {
    const last = [
      { participantId: 'a', rank: 1 },
      { participantId: 'b', rank: 2 },
    ]
    const top = rankLeaderboard([p('a', 100), p('b', 300)], last) // b overtakes a
    const b = top.find((e) => e.participantId === 'b')!
    const a = top.find((e) => e.participantId === 'a')!
    expect([b.rank, b.delta]).toEqual([1, 1]) // 2 -> 1, up one
    expect([a.rank, a.delta]).toEqual([2, -1]) // 1 -> 2, down one
  })

  it('delta is 0 for a participant not in the last top-N', () => {
    const top = rankLeaderboard([p('a', 100)], [])
    expect(top[0].delta).toBe(0)
  })

  it('caps at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => p(`p${i}`, i))
    expect(rankLeaderboard(many, null, 10)).toHaveLength(10)
  })
})

describe('resolveRoster', () => {
  const named = new Map([
    ['real-1', { participantId: 'real-1', nickname: 'Ada', avatarSeed: 'Ada' }],
    ['real-2', { participantId: 'real-2', nickname: 'Grace', avatarSeed: 'Grace' }],
  ])

  it('renders server-issued names, in presence order', () => {
    expect(resolveRoster(['real-2', 'real-1'], named).map((p) => p.nickname)).toEqual([
      'Grace',
      'Ada',
    ])
  })

  // The reason this function exists. A presence payload is client-written and the RLS
  // policy on realtime.messages cannot tell a participant from anyone else holding the
  // public anon key and the projected room code. An id the join endpoint never issued has
  // no row to resolve against, so it must render nothing at all — otherwise a nickname
  // that never passed sanitizeNickname lands on a classroom projector, and /kick cannot
  // remove it because there is no participants row to delete.
  it('drops ids the server never issued', () => {
    expect(resolveRoster(['real-1', 'forged'], named).map((p) => p.nickname)).toEqual(['Ada'])
  })

  it('renders nothing when every id is forged', () => {
    expect(resolveRoster(['forged-1', 'forged-2'], named)).toEqual([])
  })

  it('is empty for an empty room', () => {
    expect(resolveRoster([], named)).toEqual([])
  })
})
