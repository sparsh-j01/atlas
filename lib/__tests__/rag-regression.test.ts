import { describe, expect, it } from 'vitest'
import { artifactCompatibility, checkThresholds, readPath, type Threshold } from '../../evals/regression/thresholds'
const threshold: Threshold = { path: 'score', label: 'score', direction: 'higher_is_better', tolerance: 0.01, provenance: 'unit fixture' }
const artifact = () => ({
  corpusVersion: 'corpus-v1', goldenSetVersion: 'queries-v1',
  embedding: { provider: 'gemini', model: 'model-a', version: 'v1', dimension: 768 },
  reportTopK: 10, relevanceFloor: 0.62,
  runs: { runA: { pooled: Object.fromEntries(['hybrid', 'vector', 'bm25'].map((arm) => [arm, { gradedQueries: 40, negativeQueries: 10 }])) } },
})
describe('regression artifact validation (synthetic data only)', () => {
  it('marks missing metrics invalid instead of passing them', () => {
    expect(checkThresholds([threshold], { score: 0.9 }, {})[0].invalid).toBe(true)
  })
  it('rejects NaN and Infinity as measurements', () => {
    expect(readPath({ score: NaN }, 'score')).toBeNull()
    expect(readPath({ score: Infinity }, 'score')).toBeNull()
  })
  it('accepts comparable manifests and refuses missing or changed model metadata', () => {
    expect(artifactCompatibility(artifact(), artifact())).toEqual([])
    const other = artifact(); other.embedding.model = 'model-b'
    expect(artifactCompatibility(artifact(), other)).toContain('Incompatible manifest field: embedding.model')
    expect(artifactCompatibility(artifact(), {})).not.toEqual([])
  })
  it('refuses empty denominators and changed refusal thresholds', () => {
    const other = artifact(); other.runs.runA.pooled.hybrid.gradedQueries = 0; other.relevanceFloor = 0.5
    const errors = artifactCompatibility(artifact(), other)
    expect(errors).toContain('Missing or empty denominator: runs.runA.pooled.hybrid.gradedQueries')
    expect(errors).toContain('Incompatible manifest field: relevanceFloor')
  })
})
