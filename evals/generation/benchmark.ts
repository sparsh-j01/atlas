import { config } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRetriever } from '@/lib/ai/retrieve'
import { createGenerateClient, generationConfig, type GenerateFn } from '@/lib/ai/generate'
import { GOLDEN_QUERIES, GOLDEN_SET_VERSION } from '../documents/golden-queries'
import { CORPUS_DOCUMENTS, CORPUS_VERSION, corpusFullText } from '../documents/openstax-corpus'
import { EVAL_OWNER_ID, evalDocumentId } from '../seed-ids'
import { evaluateQueryGeneration } from './generator'
import {
  scoreGenerationOutcomes,
  type GenerationMetrics,
  type QueryGenerationOutcome,
} from './metrics'

config({ path: '.env.local', quiet: true })

const EVIDENCE_TOP_K = 8

// PACING IS A CORRECTNESS CONTROL HERE, NOT A COURTESY.
//
// The previous version slept 5.5s between QUERIES, but one query fires up to four provider
// calls back to back (slide, judge, and a retry of each). Against a free-tier per-minute
// cap that is a burst, and the 2026-08-23 run spent 43 of its 45 regenerations on HTTP 429.
// Those 429s were then scored as pipeline behaviour, which is how the run reported 100%
// abstention accuracy while generating five slides out of fifty.
//
// So the limiter wraps the CLIENT and paces every call, whatever stage issues it.
// ponytail: one serialised min-interval gate, no token bucket, no quota-header parsing. The
// run is minutes long and single-threaded; if this ever needs concurrency, read the headers.
const DEFAULT_RPM = 10
const RPM = Number(process.env.EVAL_RPM) > 0 ? Number(process.env.EVAL_RPM) : DEFAULT_RPM
const MIN_CALL_INTERVAL_MS = Math.ceil(60_000 / RPM)
const DEFAULT_MAX_MINUTES = 45
const MAX_WALL_CLOCK_MS =
  (Number(process.env.EVAL_MAX_MINUTES) > 0 ? Number(process.env.EVAL_MAX_MINUTES) : DEFAULT_MAX_MINUTES) * 60_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Thrown when the run exceeds a limit it declared up front. Aborts the whole benchmark and
 *  writes no artifact, because a truncated run is not a measurement. */
class EvalBudgetExceeded extends Error {}

/**
 * Paces every provider call and ENFORCES the budget the run prints before it starts.
 *
 * The printed budget used to be advisory: `Budget: <= N model calls` was a console line and
 * nothing checked it. On a metered key that is the difference between a bounded experiment
 * and an open tab, so the cap is now a hard stop. Two ceilings, because they fail
 * differently — `maxCalls` catches a retry loop that spins fast, `MAX_WALL_CLOCK_MS`
 * catches one that spins slowly behind provider backoff.
 *
 * `gate()` is exposed for calls the client seam does not own: `retriever.retrieve()` issues
 * one embedding request per query through `lib/ai/embed.ts`, which is a separate code path
 * from `GenerateFn`. Leaving it unpaced meant the one call per query that ALWAYS runs was
 * the only one outside the limiter.
 */
function createGovernor(maxCalls: number) {
  let nextAllowedAt = 0
  let calls = 0
  let chain: Promise<unknown> = Promise.resolve()
  const startedAt = Date.now()

  async function gate(): Promise<void> {
    if (calls >= maxCalls)
      throw new EvalBudgetExceeded(
        `call budget exhausted: ${calls} provider calls, cap ${maxCalls}. ` +
          `Raise it deliberately if the run genuinely needs more.`,
      )
    const elapsed = Date.now() - startedAt
    if (elapsed > MAX_WALL_CLOCK_MS)
      throw new EvalBudgetExceeded(
        `wall-clock budget exhausted: ${(elapsed / 60_000).toFixed(1)} min, cap ` +
          `${MAX_WALL_CLOCK_MS / 60_000} min. Override with EVAL_MAX_MINUTES.`,
      )
    const wait = nextAllowedAt - Date.now()
    if (wait > 0) await sleep(wait)
    nextAllowedAt = Date.now() + MIN_CALL_INTERVAL_MS
    calls += 1
  }

  return {
    callsUsed: () => calls,
    elapsedMs: () => Date.now() - startedAt,
    /** Serialise a non-GenerateFn provider call (the query embedding) through the same gate. */
    async run<T>(fn: () => Promise<T>): Promise<T> {
      const task = chain.then(async () => {
        await gate()
        return fn()
      })
      chain = task.catch(() => {})
      return task as Promise<T>
    },
    wrap(client: GenerateFn): GenerateFn {
      return (args) => {
        // Serialised through a promise chain so two in-flight calls cannot both read the
        // same `nextAllowedAt` and issue simultaneously.
        const task = chain.then(async () => {
          await gate()
          return client(args)
        })
        chain = task.catch(() => {})
        return task as ReturnType<GenerateFn>
      }
    },
  }
}

export interface FullGenerationBenchmark {
  runId: string
  timestamp: string
  corpusVersion: string
  goldenSetVersion: string
  /** Resolved from the provider seam at run time, never hardcoded — see generationConfig(). */
  model: {
    id: string
    provider: string
    generationConfig: {
      thinkingBudget: number
      slideMaxTokens: number
      judgeMaxTokens: number
      concurrency: number
      requestsPerMinute: number
    }
  }
  scope: string
  documents: {
    corpusId: string
    documentId: string
    queriesCount: number
    metrics: GenerationMetrics
  }[]
  pooledMetrics: GenerationMetrics
  outcomes: QueryGenerationOutcome[]
}

function writeGenerationArtifacts(run: FullGenerationBenchmark): { jsonPath: string; mdPath: string } {
  mkdirSync('eval-results/generation/runs', { recursive: true })

  const safeTs = run.timestamp.replace(/[:.]/g, '-')
  const prefix = `${safeTs}-${run.runId}`
  const jsonPath = `eval-results/generation/runs/${prefix}.json`
  const mdPath = `eval-results/generation/runs/${prefix}.md`

  const jsonContent = JSON.stringify(run, null, 2)
  writeFileSync(jsonPath, jsonContent + '\n')
  writeFileSync('eval-results/generation/latest.json', jsonContent + '\n')

  const mdContent = generateMarkdownReport(run)
  writeFileSync(mdPath, mdContent + '\n')
  writeFileSync('eval-results/generation/latest.md', mdContent + '\n')

  return { jsonPath, mdPath }
}

function generateMarkdownReport(run: FullGenerationBenchmark): string {
  const m = run.pooledMetrics
  const fmt = (v: number | null) => (v === null ? 'N/A' : (v * 100).toFixed(1) + '%')
  const ms = (v: number) => v.toFixed(0) + 'ms'

  let doc = `# Atlas M7 Phase 2B Generation Evaluation Benchmark\n\n`
  doc += `**Run ID**: \`${run.runId}\`  \n`
  doc += `**Timestamp**: \`${run.timestamp}\`  \n`
  doc += `**Corpus Version**: \`${run.corpusVersion}\`  \n`
  doc += `**Golden Set Version**: \`${run.goldenSetVersion}\`  \n`
  doc += `**Generation Model**: \`${run.model.id}\` (Provider: \`${run.model.provider}\`) — resolved from the provider seam at run time  \n`
  doc += `**Evaluator/Judge**: \`${run.model.id}\` (Production \`verifySlide\`)  \n`
  doc += `**Configuration**: \`thinkingBudget: 0\`, \`slideMaxTokens: ${run.model.generationConfig.slideMaxTokens}\`, \`judgeMaxTokens: ${run.model.generationConfig.judgeMaxTokens}\`, \`${run.model.generationConfig.requestsPerMinute} req/min\`  \n\n`

  doc += `> **Scope.** ${run.scope}\n\n`

  doc += `## 1. Executive Summary: Core Generation Metrics\n\n`

  if (m.inconclusiveCount > 0) {
    doc += `> **${m.inconclusiveCount} of ${m.totalQueries} queries (${fmt(m.inconclusiveRate)}) were INCONCLUSIVE** — the provider never\n`
    doc += `> answered (rate limit, timeout or block), so no pipeline decision was observed. They are\n`
    doc += `> excluded from every rate below, which is why the denominators read ${m.evaluableQueries}, not ${m.totalQueries}.\n`
    doc += `> An earlier version of this harness counted these as correct refusals and reported 100%\n`
    doc += `> abstention accuracy on a run that generated 5 slides out of 50.\n\n`
  }

  doc += `| Metric | Measured Value | Count / Denominator | Notes |\n`
  doc += `|---|---|---|---|\n`
  doc += `| **Supported Generation** | **${fmt(m.supportedGenerationRate)}** | ${m.supportedGenerationCount} / ${m.answerableQueries} | Answerable query produced a slide the judge verified. THE headline number. |\n`
  doc += `| **Groundedness** | **${fmt(m.groundedRate)}** | ${m.groundedCount} / ${m.answerableQueries} | Supported AND retrieved evidence overlaps gold source coordinates. The only metric independent of the judge's own verdict. |\n`
  doc += `| **Abstention Accuracy** | **${fmt(m.abstentionAccuracy)}** | ${m.correctAbstentionCount} / ${m.unanswerableQueries} | Unanswerable queries refused by the relevance floor or by a judge that actually ran |\n`
  doc += `| **Schema Validity** | **${fmt(m.schemaValidRate)}** | ${m.schemaValidAttempts} / ${m.payloadAttempts} attempts | Attempt-level: of attempts returning a payload, share passing \`validateSlide\` |\n`
  doc += `| **Exact Duplicate Rate** | **${fmt(m.exactDuplicateRate)}** | ${m.exactDuplicateCount} / ${m.supportedGenerationCount} | Collapsed normalized prompt match (this harness, not production's \`finalizeSlides\`) |\n`
  doc += `| **Near-Duplicate Rate** | **${fmt(m.nearDuplicateRate)}** | ${m.nearDuplicateCount} / ${m.supportedGenerationCount} | Jaccard token similarity ≥ ${m.nearDuplicateThreshold} |\n`
  doc += `| **First-Pass Success** | **${fmt(m.firstPassSuccessRate)}** | ${m.firstPassSuccessCount} / ${m.evaluableQueries} | Accepted on attempt 1 without retry |\n`
  doc += `| **Regeneration Rate** | **${fmt(m.regenerationRate)}** | ${m.regenerationCount} / ${m.evaluableQueries} | Attempt 2 triggered by a validation or judge failure |\n`
  doc += `| **Average Latency** | **${ms(m.avgLatencyMs)}** | - | Full generation + validation + judge loop (P95: ${ms(m.p95LatencyMs)}) |\n\n`

  doc += `*\`answerability\` and \`relevance\` are deliberately absent. Their implementations were*\n`
  doc += `*byte-identical to supported generation and to "a slide exists" respectively — five reported*\n`
  doc += `*metrics that were one signal. They are deleted rather than renamed; see \`evals/generation/metrics.ts\`.*\n\n`

  doc += `## 2. Abstention & Refusal Classification Breakdown\n\n`
  const share = (c: number) => (m.evaluableQueries === 0 ? 'N/A' : fmt(c / m.evaluableQueries))
  doc += `| Category | Count | Share of evaluable | Description |\n`
  doc += `|---|---|---|---|\n`
  doc += `| **Supported Generation** | ${m.supportedGenerationCount} | ${share(m.supportedGenerationCount)} | Answerable query generated and judge-verified |\n`
  doc += `| **Correct Abstention** | ${m.correctAbstentionCount} | ${share(m.correctAbstentionCount)} | Unanswerable query refused by the relevance floor or by a judge that ran |\n`
  doc += `| **False Abstention** | ${m.falseAbstentionCount} | ${share(m.falseAbstentionCount)} | Answerable query refused by the floor or by a judge that ran |\n`
  doc += `| **Unsupported Generation** | ${m.unsupportedGenerationCount} | ${share(m.unsupportedGenerationCount)} | Unanswerable query generated anyway — the hallucination case |\n`
  doc += `| *Inconclusive (excluded)* | *${m.inconclusiveCount}* | *${fmt(m.inconclusiveRate)} of ${m.totalQueries} total* | *Provider never answered. Not a pipeline decision.* |\n\n`

  doc += `## 3. Per-Document Performance Breakdown\n\n`
  for (const docInfo of run.documents) {
    const dm = docInfo.metrics
    doc += `### Document: \`${docInfo.corpusId}\` (n=${docInfo.queriesCount} queries)\n\n`
    doc += `| Metric | Rate | Count |\n`
    doc += `|---|---|---|\n`
    doc += `| Evaluable (of ${docInfo.queriesCount}) | ${fmt(1 - dm.inconclusiveRate)} | ${dm.evaluableQueries} (${dm.inconclusiveCount} inconclusive) |\n`
    doc += `| Supported Generation | ${fmt(dm.supportedGenerationRate)} | ${dm.supportedGenerationCount} / ${dm.answerableQueries} |\n`
    doc += `| Groundedness | ${fmt(dm.groundedRate)} | ${dm.groundedCount} / ${dm.answerableQueries} |\n`
    doc += `| Abstention Accuracy | ${fmt(dm.abstentionAccuracy)} | ${dm.correctAbstentionCount} / ${dm.unanswerableQueries} |\n`
    doc += `| Schema Validity | ${fmt(dm.schemaValidRate)} | ${dm.schemaValidAttempts} / ${dm.payloadAttempts} attempts |\n`
    doc += `| First-Pass Success | ${fmt(dm.firstPassSuccessRate)} | ${dm.firstPassSuccessCount} / ${dm.evaluableQueries} |\n`
    doc += `| Regeneration Rate | ${fmt(dm.regenerationRate)} | ${dm.regenerationCount} / ${dm.evaluableQueries} |\n`
    doc += `| Avg Latency | ${ms(dm.avgLatencyMs)} | (P95: ${ms(dm.p95LatencyMs)}) |\n\n`
  }

  doc += `## 4. Failure & Regeneration Analysis\n\n`
  if (Object.keys(m.regenerationReasonDistribution).length === 0) {
    doc += `*No regenerations were required across the run.*\n\n`
  } else {
    doc += `### Regeneration Reasons (Attempt 1 Failures Triggering Retry)\n\n`
    doc += `| Reason | Count |\n|---|---|\n`
    for (const [reason, count] of Object.entries(m.regenerationReasonDistribution)) {
      doc += `| \`${reason}\` | ${count} |\n`
    }
    doc += `\n`
  }

  // Reasons are provider error bodies up to 300 chars of JSON. Unclipped they turned a
  // 45-row table into an unreadable wall and hid the two rows that were real findings.
  const clip = (s: string | undefined, n = 110) =>
    !s ? 'N/A' : (s.length > n ? s.slice(0, n) + '…' : s).replace(/\s+/g, ' ').replace(/\|/g, '\\|')

  const realFailures = run.outcomes.filter(
    (o) => o.abstentionClass === 'false_abstention' || o.abstentionClass === 'unsupported_generation',
  )
  doc += `### Pipeline Failures (a decision this pipeline actually made)\n\n`
  if (realFailures.length === 0) {
    doc += `*None.*\n\n`
  } else {
    doc += `| Query ID | Category | Query | Class | Reason |\n|---|---|---|---|---|\n`
    for (const f of realFailures) {
      doc += `| \`${f.query.id}\` | ${f.query.category} | ${clip(f.query.query, 70)} | \`${f.abstentionClass}\` | ${clip(f.failureReason)} |\n`
    }
    doc += `\n`
  }

  const inconclusive = run.outcomes.filter((o) => o.abstentionClass === 'inconclusive')
  doc += `### Inconclusive (provider never answered — excluded from all rates)\n\n`
  if (inconclusive.length === 0) {
    doc += `*None. Every query reached the model.*\n\n`
  } else {
    doc += `| Query ID | Category | Reason |\n|---|---|---|\n`
    for (const f of inconclusive) {
      doc += `| \`${f.query.id}\` | ${f.query.category} | ${clip(f.failureReason)} |\n`
    }
    doc += `\n`
  }

  return doc
}

async function main(): Promise<void> {
  const specificDoc = process.argv[2]
  const ownerId = process.env.EVAL_OWNER_ID || EVAL_OWNER_ID

  const targetDocs = specificDoc
    ? CORPUS_DOCUMENTS.filter((d) => d.id === specificDoc)
    : CORPUS_DOCUMENTS

  if (targetDocs.length === 0) {
    console.error(`Unknown corpus document. Available: ${CORPUS_DOCUMENTS.map((d) => d.id).join(', ')}`)
    process.exit(2)
  }

  const runId = randomUUID().slice(0, 8)
  const timestamp = new Date().toISOString()
  const resolved = generationConfig()

  const plannedQueries = GOLDEN_QUERIES.filter((q) => targetDocs.some((d) => d.id === q.documentId)).length
  // Up to 2 slide calls + 2 judge calls per query. State the budget BEFORE the run, so a
  // quota wall is a decision made in advance rather than discovered as a burst of 429s.
  // Up to 2 slide calls + 2 judge calls per query, plus one query embedding, plus the one
  // extra pass a single inconclusive retry costs. The cap is deliberately the worst case
  // and not an estimate: it exists to stop a runaway, not to predict the bill.
  const worstCaseCalls = plannedQueries * 4
  const callCap = Number(process.env.EVAL_MAX_CALLS) > 0
    ? Number(process.env.EVAL_MAX_CALLS)
    : plannedQueries * 9 + 10
  const governor = createGovernor(callCap)
  const client = governor.wrap(createGenerateClient())

  console.log(`================ STARTING PHASE 2B GENERATION BENCHMARK ================`)
  console.log(`Run ID: ${runId}`)
  console.log(`Model : ${resolved.model} (provider ${resolved.provider})`)
  console.log(`Target: ${targetDocs.length} document(s), ${plannedQueries} golden queries`)
  console.log(
    `Budget: <= ${worstCaseCalls} model calls at ${RPM} req/min ` +
      `=> up to ~${Math.ceil((worstCaseCalls * MIN_CALL_INTERVAL_MS) / 60_000)} min. ` +
      `Override with EVAL_RPM.`,
  )
  console.log(
    `Caps  : hard stop at ${callCap} provider calls or ${MAX_WALL_CLOCK_MS / 60_000} min ` +
      `(EVAL_MAX_CALLS / EVAL_MAX_MINUTES). Exceeding either aborts and writes nothing.`,
  )

  const allOutcomes: QueryGenerationOutcome[] = []
  const documentSummaries: FullGenerationBenchmark['documents'] = []

  for (const doc of targetDocs) {
    const docId = evalDocumentId(doc.id)
    const fullText = corpusFullText(doc)
    const queries = GOLDEN_QUERIES.filter((q) => q.documentId === doc.id)

    console.log(`\nEvaluating document: ${doc.id} (${queries.length} queries)...`)
    const retriever = await createRetriever(docId, ownerId)
    const docOutcomes: QueryGenerationOutcome[] = []

    for (const q of queries) {
      process.stdout.write(`  [${q.id}] (${q.category.padEnd(18)}) "${q.query.slice(0, 45)}"... `)
      const evidence = await governor.run(() => retriever.retrieve(q.query, EVIDENCE_TOP_K))

      let outcome = await evaluateQueryGeneration(q, doc, fullText, evidence, client)

      // One retry for a query the provider never answered. `paced` already spaces the calls,
      // so this catches a quota window rather than a burst. If it comes back inconclusive
      // again the outcome is RECORDED as inconclusive — never silently folded into a
      // refusal, which is what produced the 100% abstention artifact.
      if (outcome.abstentionClass === 'inconclusive') {
        process.stdout.write(`[inconclusive, backing off 30s]... `)
        await sleep(30_000)
        outcome = await evaluateQueryGeneration(q, doc, fullText, evidence, client)
      }

      docOutcomes.push(outcome)
      allOutcomes.push(outcome)

      console.log(
        outcome.finalSlide
          ? `OK (attempts ${outcome.attempts.length}, ${outcome.totalLatencyMs}ms)`
          : `${outcome.abstentionClass.toUpperCase()} (${outcome.totalLatencyMs}ms)`,
      )
    }

    const docMetrics = scoreGenerationOutcomes(docOutcomes)
    documentSummaries.push({
      corpusId: doc.id,
      documentId: docId,
      queriesCount: queries.length,
      metrics: docMetrics,
    })
  }

  const pooledMetrics = scoreGenerationOutcomes(allOutcomes)

  const benchmarkResult: FullGenerationBenchmark = {
    runId,
    timestamp,
    corpusVersion: CORPUS_VERSION,
    goldenSetVersion: GOLDEN_SET_VERSION,
    model: {
      id: resolved.model,
      provider: resolved.provider,
      generationConfig: {
        thinkingBudget: 0,
        slideMaxTokens: 1000,
        judgeMaxTokens: 300,
        concurrency: 1,
        requestsPerMinute: RPM,
      },
    },
    scope:
      'Per-slide generation loop of app/api/decks/generate-pdf/route.ts — retrieval, relevance floor, ' +
      'prompt assembly, emit_slide, validateSlide, verifySlide, bounded regeneration. Does NOT run the ' +
      'blueprint phase, finalizeSlides (production dedupe + survival floor), mapPool concurrency, or the ' +
      'persistence transaction. Golden queries are injected where blueprint subtopics would be. ' +
      'Duplicate rates are computed by this harness, not by the shipped deduper. Not an end-to-end deck measurement.',
    documents: documentSummaries,
    pooledMetrics,
    outcomes: allOutcomes,
  }

  const { jsonPath, mdPath } = writeGenerationArtifacts(benchmarkResult)

  console.log(`\n================ GENERATION BENCHMARK COMPLETE ================`)
  console.log(`Run ID: ${runId}`)
  console.log(`Artifacts:`)
  console.log(`  JSON: ${jsonPath} (and eval-results/generation/latest.json)`)
  console.log(`  MD  : ${mdPath} (and eval-results/generation/latest.md)\n`)

  const p = pooledMetrics
  const pct = (v: number | null) => (v === null ? 'N/A' : (v * 100).toFixed(1) + '%')
  console.log(`RESULTS SUMMARY (model ${resolved.model}):`)
  console.log(`  Evaluable           : ${p.evaluableQueries}/${p.totalQueries}  (${p.inconclusiveCount} inconclusive, excluded)`)
  console.log(`  Supported Generation: ${pct(p.supportedGenerationRate)} (${p.supportedGenerationCount}/${p.answerableQueries})`)
  console.log(`  Groundedness        : ${pct(p.groundedRate)} (${p.groundedCount}/${p.answerableQueries})`)
  console.log(`  Abstention Accuracy : ${pct(p.abstentionAccuracy)} (${p.correctAbstentionCount}/${p.unanswerableQueries})`)
  console.log(`  Schema Validity     : ${pct(p.schemaValidRate)} (${p.schemaValidAttempts}/${p.payloadAttempts} attempts)`)
  console.log(`  First-Pass Success  : ${pct(p.firstPassSuccessRate)}`)
  console.log(`  Regeneration Rate   : ${pct(p.regenerationRate)}`)
  console.log(`  Exact / Near Dupes  : ${pct(p.exactDuplicateRate)} / ${pct(p.nearDuplicateRate)} (Jaccard >= ${p.nearDuplicateThreshold})`)
  console.log(`  Average Latency     : ${p.avgLatencyMs.toFixed(0)}ms (P95: ${p.p95LatencyMs.toFixed(0)}ms)`)

  console.log(
    `  Provider calls used : ${governor.callsUsed()}/${callCap} in ${(governor.elapsedMs() / 60_000).toFixed(1)} min`,
  )

  if (p.inconclusiveCount > 0) {
    console.log(
      `\n  WARNING: ${p.inconclusiveCount} queries never reached the model. Rates above are computed over ` +
        `${p.evaluableQueries} queries.\n  Lower EVAL_RPM or run one document at a time before publishing this run.`,
    )
  }

  // Exit explicitly, because reaching the end of main() is not enough to end the process.
  // The retriever holds a Postgres pool open, one per document, and those handles keep the
  // event loop alive after the artifact is already written and correct. Run b1b6e570 sat
  // there for ten minutes past completion and blocked the next benchmark in a chained
  // script — the numbers were fine, the process just never returned.
  //
  // Zero regardless of the inconclusive warning above: a warning is not a failed run, and
  // this benchmark has never used its exit code to signal publishability. Whether it should
  // is a separate decision, not one to smuggle in behind a hang fix.
  process.exit(0)
}

main().catch((err) => {
  if (err instanceof EvalBudgetExceeded) {
    // A declared limit stopped the run. Exit distinctly from a crash and say so plainly:
    // no artifact was written, so nothing downstream can cite a half-finished run.
    console.error(`\nABORTED — ${err.message}`)
    console.error('No artifact written. Re-run with a smaller document set, or raise the cap on purpose.')
    process.exit(3)
  }
  console.error('Generation benchmark execution failed:', err)
  process.exit(1)
})
