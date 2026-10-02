import { describe, it, expect } from 'vitest'
import { rankLeaderboard } from './aggregate'

describe('rankLeaderboard', () => {
  const p = (id: string, score: number) => ({ participantId: id, nickname: id, avatarSeed: id, score })

  it('sorts by score desc and assigns ranks 1..N', () => {
    const top = rankLeaderboard([p('a', 100), p('b', 300), p('c', 200)])
    expect(top.map((e) => [e.participantId, e.rank])).toEqual([['b', 1], ['c', 2], ['a', 3]])
  })

  it('breaks ties deterministically by participantId', () => {
    const top = rankLeaderboard([p('z', 100), p('a', 100)])
    expect(top.map((e) => e.participantId)).toEqual(['a', 'z'])
  })

  it('caps at the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => p(`p${i}`, i))
    expect(rankLeaderboard(many, 10)).toHaveLength(10)
  })
})
