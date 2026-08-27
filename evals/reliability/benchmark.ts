import { config } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRetriever } from '@/lib/ai/retrieve'
import { createGenerateClient, generationConfig } from '@/lib/ai/generate'
import { GOLDEN_QUERIES } from '../documents/golden-queries'
import { CORPUS_DOCUMENTS, CORPUS_VERSION, corpusFullText } from '../documents/openstax-corpus'
import { EVAL_OWNER_ID, evalDocumentId } from '../seed-ids'
import { evaluateQueryGeneration } from '../generation/generator'
import type { QueryGenerationOutcome } from '../generation/metrics'
import { scoreReliability } from './metrics'

config({ path: '.env.local', quiet: true })

/**
 * Phase 2C, master doc section 11 — repeated-run reliability.
 *
 * The most expensive thing in the eval suite, so the budget is computed and PRINTED before
 * a single call goes out, and enforced after. The master doc is explicit about why: a run
 * that blows through the quota gets its 429s counted as pipeline failures, and the
 * reliability numbers then come out wrong in the direction of looking bad.
 */

const EVIDENCE_TOP_K = 8
const DEFAULT_REPETITIONS = 3
const DEFAULT_QUERIES = 5
const DEFAULT_RPM = 8

const REPETITIONS = Number(process.env.EVAL_REPEATS) > 0 ? Number(process.env.EVAL_REPEATS) : DEFAULT_REPETITIONS
const QUERY_LIMIT = Number(process.env.EVAL_QUERIES) > 0 ? Number(process.env.EVAL_QUERIES) : DEFAULT_QUERIES
const RPM = Number(process.env.EVAL_RPM) > 0 ? Number(process.env.EVAL_RPM) : DEFAULT_RPM
const MIN_INTERVAL_MS = Math.ceil(60_000 / RPM)
const MAX_MINUTES = Number(process.env.EVAL_MAX_MINUTES) > 0 ? Number(process.env.EVAL_MAX_MINUTES) : 45

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class BudgetExceeded extends Error {}

/** Same governor shape as the generation benchmark: pace, cap, and abort without writing. */
function createGovernor(maxCalls: number) {
  let nextAt = 0
  let calls = 0
  let chain: Promise<unknown> = Promise.resolve()
  const startedAt = Date.now()
  const gate = async () => {
    if (calls >= maxCalls) throw new BudgetExceeded(`call budget exhausted: ${calls}/${maxCalls}`)
    const elapsed = Date.now() - startedAt
    if (elapsed > MAX_MINUTES * 60_000)
      throw new BudgetExceeded(`wall-clock budget exhausted: ${(elapsed / 60_000).toFixed(1)}/${MAX_MINUTES} min`)
    const wait = nextAt - Date.now()
    if (wait > 0) await sleep(wait)
    nextAt = Date.now() + MIN_INTERVAL_MS
    calls += 1
  }
  return {
    callsUsed: () => calls,
    elapsedMs: () => Date.now() - startedAt,
    run<T>(fn: () => Promise<T>): Promise<T> {
      const task = chain.then(async () => { await gate(); return fn() })
      chain = task.catch(() => {})
      return task as Promise<T>
    },
    wrap(client: ReturnType<typeof createGenerateClient>) {
      return ((args: Parameters<typeof client>[0]) => {
        const task = chain.then(async () => { await gate(); return client(args) })
        chain = task.catch(() => {})
        return task
      }) as typeof client
    },
  }
}

async function main(): Promise<void> {
  const corpusId = process.argv[2] ?? CORPUS_DOCUMENTS[0].id
  const doc = CORPUS_DOCUMENTS.find((d) => d.id === corpusId)
  if (!doc) {
    console.error(`Unknown document. Available: ${CORPUS_DOCUMENTS.map((d) => d.id).join(', ')}`)
    process.exit(2)
  }
  const ownerId = process.env.EVAL_OWNER_ID || EVAL_OWNER_ID
  const docId = evalDocumentId(doc.id)
  const fullText = corpusFullText(doc)

  // A fixed slice, not a random sample: reliability compares repetitions of the SAME work,
  // so the query set has to be identical across runs and across invocations.
  const queries = GOLDEN_QUERIES.filter((q) => q.documentId === doc.id).slice(0, QUERY_LIMIT)

  // Master doc section 11: state the budget next to the repetition count, before starting.
  const perQueryCalls = 1 /* embedding */ + 2 /* slide attempts */ + 2 /* judge */
  const projected = queries.length * REPETITIONS * perQueryCalls
  const callCap = Number(process.env.EVAL_MAX_CALLS) > 0 ? Number(process.env.EVAL_MAX_CALLS) : projected + 10

  const runId = randomUUID().slice(0, 8)
  console.log('========== PHASE 2C: RELIABILITY ==========')
  console.log(`Run ID     : ${runId}`)
  console.log(`Document   : ${doc.id}`)
  console.log(`Design     : ${queries.length} queries x ${REPETITIONS} repetitions = ${queries.length * REPETITIONS} observations`)
  console.log(`Budget     : <= ${projected} model calls at ${RPM} req/min => up to ~${Math.ceil((projected * MIN_INTERVAL_MS) / 60_000)} min`)
  console.log(`Caps       : ${callCap} calls / ${MAX_MINUTES} min, then abort and write nothing`)
  console.log(`Overrides  : EVAL_REPEATS, EVAL_QUERIES, EVAL_RPM, EVAL_MAX_CALLS, EVAL_MAX_MINUTES\n`)

  const governor = createGovernor(callCap)
  const client = governor.wrap(createGenerateClient())
  const retriever = await createRetriever(docId, ownerId)
  if (retriever.chunkCount() === 0) {
    console.error(`Document ${doc.id} has no chunks for owner ${ownerId}. Run npm run eval:seed first.`)
    process.exit(2)
  }

  const byQuery = new Map<string, QueryGenerationOutcome[]>()
  for (let rep = 1; rep <= REPETITIONS; rep++) {
    console.log(`--- repetition ${rep}/${REPETITIONS} ---`)
    for (const q of queries) {
      process.stdout.write(`  [${q.id}] ${q.category.padEnd(18)} `)
      // Re-retrieved every repetition on purpose: retrieval is part of what is being
      // measured for stability, and caching it would hide variance that a real teacher
      // generating the same deck twice would experience.
      const evidence = await governor.run(() => retriever.retrieve(q.query, EVIDENCE_TOP_K))
      const outcome = await evaluateQueryGeneration(q, doc, fullText, evidence, client)
      const list = byQuery.get(q.id) ?? []
      list.push(outcome)
      byQuery.set(q.id, list)
      console.log(outcome.finalSlide ? `OK (${outcome.totalLatencyMs}ms)` : `${outcome.abstentionClass.toUpperCase()} (${outcome.totalLatencyMs}ms)`)
    }
  }

  const m = scoreReliability(byQuery, REPETITIONS)
  console.log('\n---------- RESULTS ----------')
  console.log(`  Observations       : ${m.totalObservations}  (${m.inconclusiveRuns} inconclusive, excluded from rates)`)
  console.log(`  Success rate       : ${(m.successRate * 100).toFixed(1)}%  (${m.successfulRuns}/${m.totalObservations - m.inconclusiveRuns})`)
  console.log(`  Stability          : ${(m.stabilityRate * 100).toFixed(1)}%  (${m.stableQueries} stable, ${m.unstableQueries} unstable)`)
  console.log(`  Regenerations      : ${m.regenerationCount}`)
  console.log(`  Validation failures: ${m.validationFailureCount}`)
  console.log(`  Grounding failures : ${m.groundingFailureCount}`)
  console.log(`  Latency            : mean ${m.meanEndToEndLatencyMs.toFixed(0)}ms, p95 ${m.p95EndToEndLatencyMs.toFixed(0)}ms, sd ${m.stdDevEndToEndLatencyMs.toFixed(0)}ms`)
  console.log(`  Failure classes    : ${JSON.stringify(m.failureClassDistribution)}`)
  console.log(`  Failure reasons    : ${JSON.stringify(m.failureReasonDistribution)}`)
  console.log(`  Provider calls     : ${governor.callsUsed()}/${callCap} in ${(governor.elapsedMs() / 60_000).toFixed(1)} min`)

  if (m.unstableQueries > 0) {
    console.log('\n  Unstable queries (same input, different outcome):')
    for (const q of m.perQuery.filter((q) => !q.stable)) {
      console.log(`    ${q.queryId}: ${q.successes}/${q.repetitions} succeeded, reasons ${JSON.stringify(q.failureReasons)}`)
    }
  }

  mkdirSync('eval-results/reliability', { recursive: true })
  writeFileSync(
    'eval-results/reliability/latest.json',
    JSON.stringify(
      { runId, timestamp: new Date().toISOString(), corpusVersion: CORPUS_VERSION, documentId: doc.id,
        model: generationConfig(), design: { repetitions: REPETITIONS, queries: queries.length }, metrics: m },
      null, 2,
    ) + '\n',
  )
  console.log('\n  wrote eval-results/reliability/latest.json')

  if (m.inconclusiveRuns > 0) {
    console.log(`\n  WARNING: ${m.inconclusiveRuns} observations never reached the model. Rates exclude them, but`)
    console.log('  a run with a high inconclusive count measures the provider, not this pipeline.')
  }
}

main().catch((err) => {
  if (err instanceof BudgetExceeded) {
    console.error(`\nABORTED — ${err.message}`)
    console.error('No artifact written. Lower EVAL_REPEATS or EVAL_QUERIES, or raise the cap on purpose.')
    process.exit(3)
  }
  console.error('Reliability evaluation failed:', err)
  process.exit(1)
})
