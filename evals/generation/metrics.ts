import type { GoldenQuery } from '../documents/golden-queries'
import { normalizePrompt } from '@/lib/ai/validate'
import type { EditableSlide } from '@/lib/slides'
import type { Verdict } from '@/lib/ai/verify'

// Generation evaluation metrics (M7 Phase 2B).
//
// SCOPE, STATED SO IT IS NEVER OVERCLAIMED. This measures the PER-SLIDE generation loop of
// `app/api/decks/generate-pdf/route.ts` — retrieval → relevance floor → prompt assembly →
// emit_slide → validateSlide → verifySlide, with bounded regeneration. It does NOT run the
// blueprint phase, `finalizeSlides` (production's dedupe and survival floor), `mapPool`
// concurrency, or the persistence transaction. A golden query is injected where a blueprint
// subtopic would be. Duplicate rates here are computed by this file, NOT by the shipped
// `finalizeSlides` deduper. This is not an end-to-end deck measurement.
//
// WHAT IS MEASURED, AND WHAT EACH NUMBER'S DENOMINATOR IS:
//
//   inconclusive        the provider never answered (429 / timeout / blocked). NOT a result.
//                       Excluded from every denominator below.
//   evaluableQueries    totalQueries - inconclusive. The only honest denominator.
//   supportedGeneration answerable queries that produced a judge-verified slide.
//                       THE headline generation number.
//   grounded            supported AND the retrieved evidence overlapped gold coordinates.
//                       The only metric that is not just a restatement of the judge.
//   abstentionAccuracy  unanswerable queries the floor or the JUDGE actually refused.
//   schemaValid         attempt-level: of attempts that returned a payload, how many
//                       passed validateSlide.
//
// `answerability` and `relevance` USED TO BE REPORTED HERE AND ARE DELETED. Their
// expressions were `acceptedSlide && verdict.ok` — byte-identical to `correct` — and
// `acceptedSlide !== null`, which never checked relevance to the subtopic at all. Five
// reported metrics that are one signal read as five independent confirmations. Deleted
// rather than renamed: an implemented relevance metric needs a second judge call, and a
// placeholder that scores 100% is worse than an absent metric.

export interface GenerationAttempt {
  attemptIndex: number // 1 or 2
  rawOutput: unknown
  slide: EditableSlide | null
  schemaErrors: string[]
  judgeVerdict: Verdict | null
  latencyMs: number
  success: boolean
  /** The provider call itself failed — no model output to judge. Distinct from a model
   *  answer this pipeline rejected. */
  providerFailed: boolean
  /** One short reason this attempt did not yield an accepted slide. Absent on success. */
  failure?: string
}

export type AbstentionClassification =
  | 'correct_abstention_floor' // Unanswerable, refused by the relevance floor
  | 'correct_abstention_judge' // Unanswerable, refused by a judge that actually ran
  | 'false_abstention' // Answerable, refused by the floor or by a judge that actually ran
  | 'unsupported_generation' // Unanswerable, generated anyway
  | 'supported_generation' // Answerable, generated and judge-verified
  | 'inconclusive' // The provider never answered. Not evidence of anything.

/** Classes that represent a measured pipeline decision. `inconclusive` is not one. */
export const EVALUABLE_CLASSES: AbstentionClassification[] = [
  'correct_abstention_floor',
  'correct_abstention_judge',
  'false_abstention',
  'unsupported_generation',
  'supported_generation',
]

export interface QueryGenerationOutcome {
  query: GoldenQuery
  documentId: string
  relevancePassed: boolean
  attempts: GenerationAttempt[]
  finalSlide: EditableSlide | null
  isDuplicate: boolean
  isNearDuplicate: boolean
  duplicateOfQueryId?: string
  grounded: boolean
  correct: boolean
  abstentionClass: AbstentionClassification
  totalLatencyMs: number
  failureReason?: string
}

export interface GenerationMetrics {
  totalQueries: number
  /** Queries the provider never answered. Excluded from every rate below. */
  inconclusiveCount: number
  inconclusiveRate: number
  /** totalQueries - inconclusiveCount. The denominator for everything that follows. */
  evaluableQueries: number
  answerableQueries: number
  unanswerableQueries: number

  // 1. Schema validity — attempt-level, so it can actually fail.
  schemaValidAttempts: number
  payloadAttempts: number
  schemaValidRate: number
  schemaErrorDistribution: Record<string, number>

  // 2. Groundedness — the only metric independent of the judge's own verdict.
  groundedCount: number
  groundedRate: number

  // 3. Correctness / supported generation. One signal, reported once.
  supportedGenerationCount: number
  supportedGenerationRate: number

  // 4. Abstention breakdown
  correctAbstentionCount: number
  falseAbstentionCount: number
  unsupportedGenerationCount: number
  abstentionAccuracy: number | null

  // 5. Duplicate rates (this file's Jaccard, NOT production's finalizeSlides)
  exactDuplicateCount: number
  exactDuplicateRate: number
  nearDuplicateCount: number
  nearDuplicateRate: number
  nearDuplicateThreshold: number

  // 6. Regeneration
  totalAttempts: number
  firstPassSuccessCount: number
  firstPassSuccessRate: number
  regenerationCount: number
  regenerationRate: number
  regenerationReasonDistribution: Record<string, number>

  // Latency
  avgLatencyMs: number
  p95LatencyMs: number
}

/** Calculate Jaccard similarity over word tokens for near-duplicate detection. */
export function calculateTokenSimilarity(a: string, b: string): number {
  const normA = normalizePrompt(a).split(/\s+/).filter(Boolean)
  const normB = normalizePrompt(b).split(/\s+/).filter(Boolean)
  if (normA.length === 0 || normB.length === 0) return 0

  const setA = new Set(normA)
  const setB = new Set(normB)

  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }

  const union = new Set([...setA, ...setB]).size
  return union === 0 ? 0 : intersection / union
}

export const NEAR_DUPLICATE_SIMILARITY_THRESHOLD = 0.75

/** Flag exact and near-duplicate generated prompts across a set of query outcomes. */
export function detectDuplicates(outcomes: QueryGenerationOutcome[]): void {
  const seenNorm = new Map<string, string>() // normalized prompt -> queryId
  const acceptedSlides: { queryId: string; prompt: string }[] = []

  // Reset first: this runs once per document and again over the pooled set, and a flag left
  // over from the narrower pass would survive into a grouping that did not earn it.
  for (const o of outcomes) {
    o.isDuplicate = false
    o.isNearDuplicate = false
    o.duplicateOfQueryId = undefined
  }

  for (const o of outcomes) {
    if (!o.finalSlide) continue
    const prompt = o.finalSlide.prompt
    const norm = normalizePrompt(prompt)

    // Check exact duplicate
    if (seenNorm.has(norm)) {
      o.isDuplicate = true
      o.duplicateOfQueryId = seenNorm.get(norm)
      continue
    }
    seenNorm.set(norm, o.query.id)

    // Check near duplicate against previously accepted slides
    for (const prev of acceptedSlides) {
      const sim = calculateTokenSimilarity(prompt, prev.prompt)
      if (sim >= NEAR_DUPLICATE_SIMILARITY_THRESHOLD) {
        o.isNearDuplicate = true
        o.duplicateOfQueryId = prev.queryId
        break
      }
    }

    acceptedSlides.push({ queryId: o.query.id, prompt })
  }
}

/**
 * Aggregate generation evaluation metrics across a list of query outcomes.
 *
 * EVERY RATE EXCLUDES `inconclusive` OUTCOMES. A query the provider never answered is not
 * a pipeline decision, and counting it as one is not a rounding error — it inverts the
 * headline safety metric. In the 2026-08-23 run, all ten unanswerable queries returned
 * HTTP 429 and every one was banked as "the judge correctly refused", producing a reported
 * 100% abstention accuracy that would have scored the same with no API key at all.
 */
export function scoreGenerationOutcomes(outcomes: QueryGenerationOutcome[]): GenerationMetrics {
  detectDuplicates(outcomes)

  const n = outcomes.length
  const inconclusive = outcomes.filter((o) => o.abstentionClass === 'inconclusive')
  const evaluable = outcomes.filter((o) => o.abstentionClass !== 'inconclusive')
  const answerable = evaluable.filter((o) => o.query.category !== 'unanswerable')
  const unanswerable = evaluable.filter((o) => o.query.category === 'unanswerable')

  const schemaErrors: Record<string, number> = {}
  const regenReasons: Record<string, number> = {}

  let totalAttempts = 0
  let firstPassSuccess = 0
  let regenerations = 0
  let payloadAttempts = 0
  let schemaValidAttempts = 0

  for (const o of outcomes) {
    totalAttempts += o.attempts.length

    // Schema validity is ATTEMPT-level and counts only attempts that returned a payload.
    // The old query-level version asked "did an accepted slide have no schema errors?" over
    // slides that were accepted BECAUSE they had none — it could not report anything but
    // 100%. A model that emits a malformed payload and gets it right on the retry should
    // cost something here, and now does.
    for (const att of o.attempts) {
      if (!att.providerFailed) {
        payloadAttempts++
        if (att.schemaErrors.length === 0) schemaValidAttempts++
      }
      for (const err of att.schemaErrors) schemaErrors[err] = (schemaErrors[err] ?? 0) + 1
    }

    // Attempt bookkeeping ignores inconclusive queries for the same reason the rates do:
    // "regenerated after a 429" is a quota event, not a quality event.
    if (o.abstentionClass === 'inconclusive') continue

    if (o.attempts.length > 0 && o.attempts[0].success) firstPassSuccess++
    if (o.attempts.length > 1) {
      regenerations++
      const first = o.attempts[0]
      if (first.providerFailed) {
        regenReasons['provider_error'] = (regenReasons['provider_error'] ?? 0) + 1
      } else if (first.schemaErrors.length > 0) {
        regenReasons[first.schemaErrors[0]] = (regenReasons[first.schemaErrors[0]] ?? 0) + 1
      } else if (first.judgeVerdict && !first.judgeVerdict.ok) {
        const failure = first.judgeVerdict.failures[0] || 'judge_rejected'
        regenReasons[failure] = (regenReasons[failure] ?? 0) + 1
      } else {
        regenReasons['other'] = (regenReasons['other'] ?? 0) + 1
      }
    }
  }

  const generatedSlides = evaluable.filter((o) => o.finalSlide !== null)
  const groundedCount = answerable.filter((o) => o.grounded).length

  const supportedGen = evaluable.filter((o) => o.abstentionClass === 'supported_generation').length
  const correctAbstention = evaluable.filter(
    (o) => o.abstentionClass === 'correct_abstention_floor' || o.abstentionClass === 'correct_abstention_judge',
  ).length
  const falseAbstention = evaluable.filter((o) => o.abstentionClass === 'false_abstention').length
  const unsupportedGen = evaluable.filter((o) => o.abstentionClass === 'unsupported_generation').length

  const exactDupCount = evaluable.filter((o) => o.isDuplicate).length
  const nearDupCount = evaluable.filter((o) => o.isNearDuplicate).length

  const latencies = evaluable.map((o) => o.totalLatencyMs).sort((a, b) => a - b)
  const e = evaluable.length

  return {
    totalQueries: n,
    inconclusiveCount: inconclusive.length,
    inconclusiveRate: n === 0 ? 0 : inconclusive.length / n,
    evaluableQueries: e,
    answerableQueries: answerable.length,
    unanswerableQueries: unanswerable.length,

    schemaValidAttempts,
    payloadAttempts,
    schemaValidRate: payloadAttempts === 0 ? 0 : schemaValidAttempts / payloadAttempts,
    schemaErrorDistribution: schemaErrors,

    groundedCount,
    groundedRate: answerable.length === 0 ? 0 : groundedCount / answerable.length,

    supportedGenerationCount: supportedGen,
    supportedGenerationRate: answerable.length === 0 ? 0 : supportedGen / answerable.length,

    correctAbstentionCount: correctAbstention,
    falseAbstentionCount: falseAbstention,
    unsupportedGenerationCount: unsupportedGen,
    // Null, not 1.0, over zero examples — "100% correct abstention" across nothing reads as
    // a passing score and is the same vacuity the retrieval metrics already guard against.
    abstentionAccuracy: unanswerable.length === 0 ? null : correctAbstention / unanswerable.length,

    exactDuplicateCount: exactDupCount,
    exactDuplicateRate: generatedSlides.length === 0 ? 0 : exactDupCount / generatedSlides.length,
    nearDuplicateCount: nearDupCount,
    nearDuplicateRate: generatedSlides.length === 0 ? 0 : nearDupCount / generatedSlides.length,
    nearDuplicateThreshold: NEAR_DUPLICATE_SIMILARITY_THRESHOLD,

    totalAttempts,
    firstPassSuccessCount: firstPassSuccess,
    firstPassSuccessRate: e === 0 ? 0 : firstPassSuccess / e,
    regenerationCount: regenerations,
    regenerationRate: e === 0 ? 0 : regenerations / e,
    regenerationReasonDistribution: regenReasons,

    avgLatencyMs: e === 0 ? 0 : evaluable.reduce((s, o) => s + o.totalLatencyMs, 0) / e,
    p95LatencyMs: e === 0 ? 0 : latencies[Math.min(e - 1, Math.ceil(0.95 * e) - 1)],
  }
}
