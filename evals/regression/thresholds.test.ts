import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { RETRIEVAL_THRESHOLDS, checkThresholds, readPath, type Threshold } from './thresholds'

const baseline = { runs: { runA: { pooled: { hybrid: { mrr: 0.92, recallAt8: 1.0 } } } } }

describe('readPath', () => {
  it('reads a nested metric', () => {
    expect(readPath(baseline, 'runs.runA.pooled.hybrid.mrr')).toBe(0.92)
  })

  it('returns null for a missing path instead of throwing', () => {
    // A missing metric is a real outcome the checker reports; throwing would take down a
    // scheduled run over a renamed field.
    expect(readPath(baseline, 'runs.runB.pooled.hybrid.mrr')).toBeNull()
    expect(readPath(baseline, 'nope.nope')).toBeNull()
    expect(readPath(null, 'a.b')).toBeNull()
  })

  it('returns null when the value is not a number', () => {
    expect(readPath({ a: { b: 'high' } }, 'a.b')).toBeNull()
  })
})

describe('shipped thresholds', () => {
  it('never carries a tolerance without the runs it was derived from', () => {
    // The guard for the mistake this file was written to avoid, restated as an invariant
    // rather than a snapshot. It used to assert every tolerance was null, which pinned a
    // transient state: the thresholds were armed on 2026-09-09 and the test failed for
    // being out of date rather than for catching anything. What must stay true is the
    // pairing — a number that can fail a run has to name the evidence behind it, and the
    // previous invented thresholds (recallAt5 0.85, mrr 0.8) were deleted precisely
    // because they could not.
    for (const t of RETRIEVAL_THRESHOLDS) {
      if (t.tolerance === null) {
        expect(t.provenance, `${t.label} is report-only but claims provenance`).toBe('')
      } else {
        expect(t.tolerance, `${t.label} has a non-positive tolerance`).toBeGreaterThan(0)
        expect(
          t.provenance,
          `${t.label} is armed but names no run ids — a tolerance from nowhere is a guess`,
        ).not.toBe('')
      }
    }
  })

  it('names a direction for every metric', () => {
    for (const t of RETRIEVAL_THRESHOLDS) {
      expect(['higher_is_better', 'lower_is_better']).toContain(t.direction)
    }
  })

  it('every path resolves against the committed benchmark artifact', () => {
    // The guard for the bug this file shipped with: the paths originally pointed at
    // `pooled.<arm>.metrics.<name>`, but the metrics sit directly under `pooled.<arm>`.
    // Every threshold silently read null and the checker reported "not present" for all
    // five while claiming they were armed. A regression checker that cannot find its own
    // metrics passes every run, which is the worst possible failure mode for one.
    const artifact = JSON.parse(readFileSync('eval-results/latest.json', 'utf8'))
    for (const t of RETRIEVAL_THRESHOLDS) {
      expect(readPath(artifact, t.path), `${t.label} (${t.path}) does not resolve`).not.toBeNull()
    }
  })
})

describe('checkThresholds', () => {
  const armed: Threshold[] = [{
    path: 'runs.runA.pooled.hybrid.mrr',
    label: 'hybrid MRR',
    direction: 'higher_is_better',
    tolerance: 0.02,
    provenance: 'test',
  }]

  it('never fails while a threshold is report-only', () => {
    // Report-only semantics, tested against an explicitly report-only threshold rather than
    // against whatever RETRIEVAL_THRESHOLDS happens to ship — those are armed now, and this
    // test is about the null-tolerance branch, not about the shipped list.
    const reportOnly: Threshold[] = [{ ...armed[0], tolerance: null, provenance: '' }]
    const current = { runs: { runA: { pooled: { hybrid: { mrr: 0.10, recallAt8: 0.1 } } } } }
    const results = checkThresholds(reportOnly, baseline, current)
    // A catastrophic drop, still not a failure — the delta is reported instead.
    expect(results.some((r) => r.regressed)).toBe(false)
    expect(results[0].armed).toBe(false)
    expect(results[0].delta).toBeCloseTo(-0.82, 5)
  })

  it('the shipped thresholds do catch a catastrophic drop', () => {
    // The other half, and the point of arming them: the real list must be able to fail.
    // While all five were report-only this was impossible, and the checker was decoration.
    const current = { runs: { runA: { pooled: { hybrid: { mrr: 0.10, recallAt8: 0.1 } } } } }
    const results = checkThresholds(RETRIEVAL_THRESHOLDS, baseline, current)
    expect(results.some((r) => r.regressed)).toBe(true)
  })

  it('fails an armed threshold only when it moves the wrong way past tolerance', () => {
    const worse = { runs: { runA: { pooled: { hybrid: { mrr: 0.80 } } } } }
    expect(checkThresholds(armed, baseline, worse)[0].regressed).toBe(true)
  })

  it('does not fail on movement within tolerance', () => {
    const noise = { runs: { runA: { pooled: { hybrid: { mrr: 0.91 } } } } }
    expect(checkThresholds(armed, baseline, noise)[0].regressed).toBe(false)
  })

  it('does not fail on a large improvement', () => {
    // higher_is_better, so a big jump is not a regression however far it moved.
    const better = { runs: { runA: { pooled: { hybrid: { mrr: 0.99 } } } } }
    expect(checkThresholds(armed, baseline, better)[0].regressed).toBe(false)
  })

  it('reports a missing metric without failing', () => {
    const r = checkThresholds(armed, baseline, { runs: {} })[0]
    expect(r.regressed).toBe(false)
    expect(r.note).toContain('not present in the current artifact')
  })
})
