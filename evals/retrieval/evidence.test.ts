import { describe, expect, it } from 'vitest'
import {
  chunksSpanned,
  coversAllEvidence,
  firstOverlapRank,
  overlaps,
  spanToInterval,
  verifyInterval,
  type GoldInterval,
  type RetrievedChunk,
} from './evidence'

// Each block below is one of the ways substring grading failed on a real corpus. The point
// of interval grading is that these all become expressible; the point of these tests is
// that they stay expressible.

const chunk = (id: string, charStart: number, charEnd: number, text = 'x'): RetrievedChunk => ({
  chunkId: id,
  charStart,
  charEnd,
  text,
  similarity: null,
})
const ev = (charStart: number, charEnd: number, text = 'x'): GoldInterval => ({
  charStart,
  charEnd,
  text,
})

describe('overlaps', () => {
  it('is true when ranges share any character', () => {
    expect(overlaps({ charStart: 0, charEnd: 10 }, { charStart: 5, charEnd: 15 })).toBe(true)
    expect(overlaps({ charStart: 5, charEnd: 15 }, { charStart: 0, charEnd: 10 })).toBe(true)
  })

  it('is true when one range contains the other, either way round', () => {
    expect(overlaps({ charStart: 0, charEnd: 100 }, { charStart: 40, charEnd: 50 })).toBe(true)
    expect(overlaps({ charStart: 40, charEnd: 50 }, { charStart: 0, charEnd: 100 })).toBe(true)
  })

  it('is FALSE for touching ranges', () => {
    // A chunk ending exactly where the evidence starts contains none of it. Getting this
    // wrong would credit a retriever for the chunk immediately before the answer.
    expect(overlaps({ charStart: 0, charEnd: 10 }, { charStart: 10, charEnd: 20 })).toBe(false)
    expect(overlaps({ charStart: 10, charEnd: 20 }, { charStart: 0, charEnd: 10 })).toBe(false)
  })

  it('is false for disjoint ranges', () => {
    expect(overlaps({ charStart: 0, charEnd: 5 }, { charStart: 90, charEnd: 95 })).toBe(false)
  })

  it('is false for a zero-width range', () => {
    expect(overlaps({ charStart: 5, charEnd: 5 }, { charStart: 0, charEnd: 10 })).toBe(false)
  })
})

describe('firstOverlapRank', () => {
  it('returns the 1-based rank of the first overlapping chunk', () => {
    const retrieved = [chunk('a', 0, 100), chunk('b', 100, 200), chunk('c', 200, 300)]
    expect(firstOverlapRank(retrieved, [ev(210, 240)])).toBe(3)
    expect(firstOverlapRank(retrieved, [ev(0, 10)])).toBe(1)
  })

  it('returns 0 when nothing overlaps', () => {
    expect(firstOverlapRank([chunk('a', 0, 100)], [ev(500, 600)])).toBe(0)
  })

  it('returns 0 for a query with no evidence, so negatives never score a hit', () => {
    expect(firstOverlapRank([chunk('a', 0, 100)], [])).toBe(0)
  })

  it('scores evidence that STRADDLES a chunk boundary', () => {
    // The case substring grading could never score: this evidence is in no single chunk's
    // text, so `chunk.text.includes(span)` was false everywhere and the query was
    // permanently unscoreable.
    const retrieved = [chunk('b', 100, 200), chunk('a', 0, 100)]
    const straddling = ev(95, 105)
    expect(firstOverlapRank(retrieved, [straddling])).toBe(1)
    expect(chunksSpanned([{ charStart: 0, charEnd: 100 }, { charStart: 100, charEnd: 200 }], straddling)).toBe(2)
  })

  it('accepts any one of several alternate passages', () => {
    // A different valid passage supporting the same answer used to count as a miss.
    const retrieved = [chunk('far', 900, 1000)]
    expect(firstOverlapRank(retrieved, [ev(0, 50), ev(950, 980)])).toBe(1)
  })
})

describe('coversAllEvidence', () => {
  it('is true only when every required interval was retrieved', () => {
    const both = [chunk('a', 0, 100), chunk('b', 400, 500)]
    const one = [chunk('a', 0, 100)]
    const required = [ev(10, 20), ev(410, 420)]
    expect(coversAllEvidence(both, required)).toBe(true)
    expect(coversAllEvidence(one, required)).toBe(false)
  })

  it('differs from firstOverlapRank exactly when evidence is split', () => {
    // This gap IS the measurement for the contextual and boundary categories: found-one is
    // not the same as has-enough-to-answer.
    const partial = [chunk('a', 0, 100)]
    const required = [ev(10, 20), ev(410, 420)]
    expect(firstOverlapRank(partial, required)).toBe(1)
    expect(coversAllEvidence(partial, required)).toBe(false)
  })

  it('is false for a query with no evidence', () => {
    expect(coversAllEvidence([chunk('a', 0, 100)], [])).toBe(false)
  })
})

describe('spanToInterval', () => {
  const text = 'The denarius was the standard Roman silver coin from 211 BC.'

  it('locates an unambiguous span', () => {
    const r = spanToInterval(text, 'standard Roman silver coin')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(text.slice(r.value.charStart, r.value.charEnd)).toBe('standard Roman silver coin')
    }
  })

  it('REJECTS an ambiguous span rather than taking the first occurrence', () => {
    // Silently resolving to the first copy is how substring grading graded the wrong
    // passage. Better to fail at authoring time than to grade the wrong thing forever.
    const dup = 'the cell divides. later, the cell divides.'
    const r = spanToInterval(dup, 'the cell divides')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ambiguous')
  })

  it('rejects a span that is not present', () => {
    const r = spanToInterval(text, 'photosynthesis')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('not found')
  })

  it('rejects an empty span', () => {
    expect(spanToInterval(text, '').ok).toBe(false)
  })
})

describe('verifyInterval', () => {
  const text = 'abcdefghij'

  it('passes when the slice equals the recorded text', () => {
    expect(verifyInterval(text, { charStart: 2, charEnd: 5, text: 'cde' })).toEqual({ ok: true })
  })

  it('fails on a text mismatch, which is how a mistyped offset is caught', () => {
    const r = verifyInterval(text, { charStart: 2, charEnd: 5, text: 'xyz' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('text mismatch')
  })

  it('fails when out of bounds', () => {
    const r = verifyInterval(text, { charStart: 8, charEnd: 99, text: 'ij' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('out of bounds')
  })

  it('fails on an empty or inverted range', () => {
    expect(verifyInterval(text, { charStart: 5, charEnd: 5, text: '' }).ok).toBe(false)
    expect(verifyInterval(text, { charStart: 6, charEnd: 3, text: '' }).ok).toBe(false)
  })
})
