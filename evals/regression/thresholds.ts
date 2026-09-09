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
 * A tolerance can only be set from OBSERVED VARIANCE in THE METRIC IT GUARDS, and variance
 * needs repeated runs. Until that exists for a metric, its tolerance stays null and the
 * checker reports the delta without failing on it.
 *
 * WHICH RUN PRODUCES THAT VARIANCE — this file used to name the wrong one.
 *
 * Every `path` below reads `runs.runA.pooled.*` out of a RETRIEVAL artifact: recall@8, MRR,
 * all-evidence recall. So the only thing that can arm them is repeated runs of the retrieval
 * benchmark, `npm run eval:benchmark`, compared against each other.
 *
 * The earlier instruction here said to run `npm run eval:reliability` and take a standard
 * deviation from it. That does not work, and it is not a matter of degree: the reliability
 * benchmark exercises the GENERATION path and reports success rate, stability rate and
 * end-to-end latency. It emits no recall and no MRR. Its run `3ba9763f` (2026-08-28)
 * measured 100% stability and a 494ms latency spread — true, and silent on whether hybrid
 * MRR moves between retrieval runs, which is the only question these tolerances ask.
 *
 * To arm one, honestly:
 *   1. Run `npm run eval:benchmark` N times against an unchanged corpus, queries and
 *      embedder. N >= 3; the artifacts land in eval-results/runs/.
 *   2. Take the spread of THAT metric across those artifacts.
 *   3. Set the tolerance wider than the spread, so ordinary noise cannot fail a run.
 *   4. Put the run ids it came from in `provenance`, so a future reader can check the
 *      number instead of trusting it.
 *
 * DONE, 2026-09-09. Three runs — `2a97fb71` (2026-08-23), `73a192e1` and `2664d34d`
 * (both 2026-09-09) — against identical corpusVersion `golden-corpus-v1`, goldenSetVersion
 * `golden-queries-v1` and embedder `gemini-embedding-001`/768.
 *
 * Measured spread on all five metrics: EXACTLY 0. Not "close to zero" — the three artifacts
 * agree bit-for-bit at full float precision, 17 days apart. Retrieval over a frozen corpus
 * with frozen embeddings is deterministic, and that is now measured rather than assumed.
 *
 * Which leaves step 3 with a problem the list above did not anticipate: a tolerance set
 * "wider than the spread" of zero is still zero, and a zero tolerance fails a run on float
 * wobble in the last bit. So the tolerances below are NOT derived from noise — there is
 * none. They are derived from the GRANULARITY of the graded set: the smallest real change
 * one query can produce across the 40 graded queries (51 golden queries minus the 10
 * `unanswerable` negatives, which are scored by abstention, not by rank).
 *
 *   recall@8, allEvidenceRecall@8   one query drops out of the top 8   = 1/40   = 0.025
 *   MRR                             one query slips rank 1 → rank 2    = 0.5/40 = 0.0125
 *
 * So each threshold below means: ONE query may regress by a position, or fall out of the
 * top 8, without failing the run. TWO may not. That is a deliberate choice of sensitivity,
 * written down here so it can be argued with — not a noise floor, because the noise floor
 * is zero and would arm nothing.
 *
 * These numbers stop being valid the moment the corpus, the golden set or the embedding
 * model changes. All three are stamped into every artifact; when any of them moves the
 * checker gets re-baselined, not re-tuned.
 */

export interface Threshold {
  /** Dotted path into the run artifact, e.g. `runs.runA.pooled.hybrid.mrr`. */
  path: string
  label: string
  /** Which direction is a regression. */
  direction: 'higher_is_better' | 'lower_is_better'
  /**
   * Allowed movement before the checker fails. `null` means report-only: the delta is
   * printed and nothing fails. Null until repeated runs of the RETRIEVAL benchmark have
   * measured this metric's own run-to-run spread — see the header.
   */
  tolerance: number | null
  /** The run ids the tolerance was derived from. Empty while report-only. */
  provenance: string
}

export const RETRIEVAL_THRESHOLDS: Threshold[] = [
  {
    path: 'runs.runA.pooled.hybrid.recallAt8',
    label: 'hybrid recall@8 (production top-k)',
    direction: 'higher_is_better',
    tolerance: 0.025,
    provenance: 'runs 2a97fb71, 73a192e1, 2664d34d — measured spread 0; value is the 40-query granularity floor',
  },
  {
    path: 'runs.runA.pooled.hybrid.mrr',
    label: 'hybrid MRR',
    direction: 'higher_is_better',
    tolerance: 0.0125,
    provenance: 'runs 2a97fb71, 73a192e1, 2664d34d — measured spread 0; value is the 40-query granularity floor',
  },
  {
    path: 'runs.runA.pooled.hybrid.allEvidenceRecallAt8',
    label: 'hybrid all-evidence recall@8',
    direction: 'higher_is_better',
    tolerance: 0.025,
    provenance: 'runs 2a97fb71, 73a192e1, 2664d34d — measured spread 0; value is the 40-query granularity floor',
  },
  {
    path: 'runs.runA.pooled.vector.mrr',
    label: 'vector-only MRR',
    direction: 'higher_is_better',
    tolerance: 0.0125,
    provenance: 'runs 2a97fb71, 73a192e1, 2664d34d — measured spread 0; value is the 40-query granularity floor',
  },
  {
    path: 'runs.runA.pooled.bm25.mrr',
    label: 'BM25-only MRR',
    direction: 'higher_is_better',
    tolerance: 0.0125,
    provenance: 'runs 2a97fb71, 73a192e1, 2664d34d — measured spread 0; value is the 40-query granularity floor',
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
        note: 'report-only: no tolerance yet — needs repeated retrieval runs to measure this metric\'s spread',
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
