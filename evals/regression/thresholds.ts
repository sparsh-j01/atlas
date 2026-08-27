/**
 * Phase 2F, master doc section 15 — regression thresholds.
 *
 * EVERY THRESHOLD HERE IS REPORT-ONLY, ON PURPOSE.
 *
 * The master doc is explicit: do not invent thresholds before the first benchmark, and
 * this file is where that rule gets obeyed rather than restated. `evals/retrieval/metrics.ts`
 * previously exported recallAt5: 0.85, recallAt10: 0.95, mrr: 0.8 and correctAbstentions: 1.0,
 * all written before anything had been measured and against a corpus where plain BM25
 * scored 1.000. They were deleted; re-adding guessed numbers in a new file would be the
 * same mistake with a better filename.
 *
 * A tolerance can only be set from OBSERVED VARIANCE, and variance needs repeated runs.
 * That is Phase 2C. Until a reliability run has produced a spread for a metric, its
 * tolerance stays null and the checker reports the delta without failing on it.
 *
 * To arm one: run `npm run eval:reliability`, take the standard deviation for that metric,
 * set the tolerance wider than normal run-to-run noise, and record which run it came from.
 */

export interface Threshold {
  /** Dotted path into the run artifact, e.g. `runs.runA.pooled.hybrid.mrr`. */
  path: string
  label: string
  /** Which direction is a regression. */
  direction: 'higher_is_better' | 'lower_is_better'
  /**
   * Allowed movement before the checker fails. `null` means report-only: the delta is
   * printed and nothing fails. Null until Phase 2C measures the variance.
   */
  tolerance: number | null
  /** Where the tolerance came from. Empty while report-only. */
  provenance: string
}

export const RETRIEVAL_THRESHOLDS: Threshold[] = [
  {
    path: 'runs.runA.pooled.hybrid.recallAt8',
    label: 'hybrid recall@8 (production top-k)',
    direction: 'higher_is_better',
    tolerance: null,
    provenance: '',
  },
  {
    path: 'runs.runA.pooled.hybrid.mrr',
    label: 'hybrid MRR',
    direction: 'higher_is_better',
    tolerance: null,
    provenance: '',
  },
  {
    path: 'runs.runA.pooled.hybrid.allEvidenceRecallAt8',
    label: 'hybrid all-evidence recall@8',
    direction: 'higher_is_better',
    tolerance: null,
    provenance: '',
  },
  {
    path: 'runs.runA.pooled.vector.mrr',
    label: 'vector-only MRR',
    direction: 'higher_is_better',
    tolerance: null,
    provenance: '',
  },
  {
    path: 'runs.runA.pooled.bm25.mrr',
    label: 'BM25-only MRR',
    direction: 'higher_is_better',
    tolerance: null,
    provenance: '',
  },
]

/** Read a dotted path out of a parsed artifact. Returns null rather than throwing, because
 *  a missing metric is a real outcome the checker should report as such. */
export function readPath(obj: unknown, path: string): number | null {
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[key]
  }
  return typeof cur === 'number' ? cur : null
}

export interface RegressionResult {
  label: string
  path: string
  /** True when a tolerance is set, i.e. this threshold is capable of failing a run. */
  armed: boolean
  baseline: number | null
  current: number | null
  delta: number | null
  /** True only when a tolerance is armed AND the movement exceeds it in the bad direction. */
  regressed: boolean
  /** Why this did not fail, when it did not. */
  note: string
}

export function checkThresholds(
  thresholds: Threshold[],
  baselineArtifact: unknown,
  currentArtifact: unknown,
): RegressionResult[] {
  return thresholds.map((t) => {
    const baseline = readPath(baselineArtifact, t.path)
    const current = readPath(currentArtifact, t.path)

    if (baseline === null || current === null) {
      return {
        label: t.label,
        path: t.path,
        armed: t.tolerance !== null,
        baseline,
        current,
        delta: null,
        regressed: false,
        note: baseline === null ? 'not present in the baseline artifact' : 'not present in the current artifact',
      }
    }

    const raw = current - baseline
    const movedWrongWay = t.direction === 'higher_is_better' ? raw < 0 : raw > 0
    const magnitude = Math.abs(raw)

    if (t.tolerance === null) {
      return {
        label: t.label,
        path: t.path,
        armed: false,
        baseline,
        current,
        delta: raw,
        regressed: false,
        note: 'report-only: no tolerance set until Phase 2C measures run-to-run variance',
      }
    }

    const regressed = movedWrongWay && magnitude > t.tolerance
    return {
      label: t.label,
      path: t.path,
      armed: true,
      baseline,
      current,
      delta: raw,
      regressed,
      note: regressed
        ? `exceeds tolerance ${t.tolerance} (${t.provenance})`
        : `within tolerance ${t.tolerance}`,
    }
  })
}
