import { readFileSync, existsSync } from 'node:fs'
import { RETRIEVAL_THRESHOLDS, checkThresholds } from './thresholds'

/**
 * Phase 2F — compare a retrieval run against the committed baseline artifact.
 *
 * Intended for a scheduled or manual run, not for every PR: producing the current artifact
 * costs embeddings. The PR-safe half of Phase 2F is the deterministic vitest suite, which
 * CI already runs on every push.
 *
 *   npm run eval:regression [currentArtifact] [baselineArtifact]
 */

const BASELINE_DEFAULT = 'eval-results/runs/2026-08-23T18-47-27-791Z-2a97fb71.json'
const CURRENT_DEFAULT = 'eval-results/latest.json'

function load(path: string): unknown {
  if (!existsSync(path)) {
    console.error(`Missing artifact: ${path}`)
    process.exit(2)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function main(): void {
  const currentPath = process.argv[2] ?? CURRENT_DEFAULT
  const baselinePath = process.argv[3] ?? BASELINE_DEFAULT

  const results = checkThresholds(RETRIEVAL_THRESHOLDS, load(baselinePath), load(currentPath))

  console.log('========== PHASE 2F: RETRIEVAL REGRESSION ==========')
  console.log(`Baseline: ${baselinePath}`)
  console.log(`Current : ${currentPath}\n`)

  let armed = 0
  for (const r of results) {
    const fmt = (x: number | null) => (x === null ? '  --  ' : x.toFixed(4))
    const sign = r.delta !== null && r.delta > 0 ? '+' : ''
    const status = r.regressed ? 'REGRESSED' : r.armed ? 'ok       ' : 'report   '
    console.log(`  ${status} ${r.label.padEnd(36)} ${fmt(r.baseline)} -> ${fmt(r.current)}  ${r.delta === null ? '' : sign + r.delta.toFixed(4)}`)
    console.log(`            ${r.note}`)
    if (r.armed) armed += 1
  }

  const regressed = results.filter((r) => r.regressed)
  console.log(`\n  ${armed}/${results.length} thresholds armed. ${regressed.length} regression(s).`)
  if (armed === 0) {
    console.log('  No threshold can fail yet, by design: every tolerance needs the run-to-run')
    console.log('  spread of the metric it guards, and these all guard RETRIEVAL metrics — so')
    console.log('  they can only be armed from repeated `npm run eval:benchmark` runs.')
    console.log('  See evals/regression/thresholds.ts for the steps.')
  }
  if (regressed.length > 0) process.exit(1)
}

main()
