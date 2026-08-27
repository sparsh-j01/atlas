import { estimateTokens } from '@/lib/ai/chunk'
import type { RetrievalResult } from '@/lib/ai/retrieve'

/**
 * Phase 2E, master doc section 14 — the eval-only no-retrieval baseline.
 *
 * The baseline is `document -> LLM`: the WHOLE document in one context window, no chunking,
 * no ranking, no relevance gate. That is only an honest comparison while the document
 * actually fits.
 *
 * The master doc calls the truncation rule BLOCKING, and it is right. A baseline truncated
 * to the first N tokens loses every query whose evidence sits late in the document, so the
 * resulting "RAG wins" delta would measure the truncation rule and not retrieval at all.
 * Nothing here silently truncates: the result records whether it happened and by how much,
 * and the runner refuses to publish a headline comparison when it did.
 */

/** Conservative input budget for one baseline call. Leaves room for the system prompt, the
 *  tool schema and the response, which all share the window with the document. */
export const BASELINE_CONTEXT_TOKENS = 120_000

/** Above the production relevance floor, because the baseline HAS no relevance gate. The
 *  whole point of the arm is an ungated document, so letting the floor abstain here would
 *  score the baseline on a control it is defined not to have. */
const BASELINE_SIMILARITY = 0.99

export interface BaselineContext {
  /** One synthetic result carrying the whole (possibly truncated) document. */
  evidence: RetrievalResult[]
  truncated: boolean
  originalTokens: number
  usedTokens: number
  /** Fraction of the document dropped. 0 when it fit. */
  droppedFraction: number
}

export function buildBaselineContext(
  fullText: string,
  budgetTokens: number = BASELINE_CONTEXT_TOKENS,
): BaselineContext {
  const originalTokens = estimateTokens(fullText)
  const truncated = originalTokens > budgetTokens

  // Proportional cut, since estimateTokens is a chars-per-token approximation rather than a
  // real tokenizer. Truncation is a reported defect here, not a feature to tune.
  const text = truncated
    ? fullText.slice(0, Math.floor(fullText.length * (budgetTokens / originalTokens)))
    : fullText

  const usedTokens = estimateTokens(text)

  return {
    evidence: [
      {
        chunkId: 'baseline-whole-document',
        text,
        score: 1,
        rank: 1,
        similarity: BASELINE_SIMILARITY,
        source: { page: 1, section: 'whole document', charStart: 0, charEnd: text.length },
      },
    ],
    truncated,
    originalTokens,
    usedTokens,
    droppedFraction: originalTokens === 0 ? 0 : Math.max(0, 1 - usedTokens / originalTokens),
  }
}

export interface ArmSummary {
  groundedRate: number
  /** Answerable queries that produced a slide the judge supported. This is the correctness
   *  measure the generation metrics actually expose — `answerability` and `relevance` were
   *  removed as duplicates of it, so reporting a separate "correctness" here would be
   *  inventing a number the pipeline does not compute. */
  supportedGenerationRate: number
  schemaValidRate: number
  unsupportedGenerationCount: number
  supportedGenerationCount: number
  meanLatencyMs: number
  evaluableQueries: number
  inconclusiveCount: number
}

export interface ArmDelta {
  metric: string
  baseline: number
  rag: number
  delta: number
}

/** Deltas are RAG minus baseline, so a positive number always means RAG did better —
 *  except for unsupported generation, where fewer is better and the sign is flipped so the
 *  column reads consistently. */
export function compareArms(baseline: ArmSummary, rag: ArmSummary): ArmDelta[] {
  const d = (metric: string, b: number, r: number, lowerIsBetter = false): ArmDelta => ({
    metric,
    baseline: b,
    rag: r,
    delta: lowerIsBetter ? b - r : r - b,
  })
  return [
    d('groundedness', baseline.groundedRate, rag.groundedRate),
    d('supported generation', baseline.supportedGenerationRate, rag.supportedGenerationRate),
    d('schema valid', baseline.schemaValidRate, rag.schemaValidRate),
    d('unsupported generation', baseline.unsupportedGenerationCount, rag.unsupportedGenerationCount, true),
    d('mean latency ms', baseline.meanLatencyMs, rag.meanLatencyMs, true),
  ]
}

/**
 * Whether the two arms can be compared as `PDF -> LLM` versus `Atlas RAG` at all.
 *
 * Master doc section 14: if the baseline truncated, the comparison is not publishable in
 * that form and must be reported as truncation-confounded instead.
 */
export function comparabilityOf(ctx: BaselineContext): { publishable: boolean; reason: string } {
  if (!ctx.truncated) {
    return {
      publishable: true,
      reason: `baseline saw the whole document (${ctx.originalTokens} tokens, within the ${BASELINE_CONTEXT_TOKENS}-token budget)`,
    }
  }
  return {
    publishable: false,
    reason:
      `TRUNCATION-CONFOUNDED: the baseline saw ${ctx.usedTokens} of ${ctx.originalTokens} tokens ` +
      `(${(ctx.droppedFraction * 100).toFixed(1)}% dropped). Any delta measures the truncation rule, not retrieval.`,
  }
}
