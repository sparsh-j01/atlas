import { config } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRetriever } from '@/lib/ai/retrieve'
import { createGenerateClient, generationConfig, type GenerateFn } from '@/lib/ai/generate'
import { GOLDEN_QUERIES, GOLDEN_SET_VERSION } from '../documents/golden-queries'
import { CORPUS_DOCUMENTS, CORPUS_VERSION, corpusFullText } from '../documents/openstax-corpus'
import { EVAL_OWNER_ID, evalDocumentId } from '../seed-ids'
import { evaluateQueryGeneration } from '../generation/generator'
import { scoreGenerationOutcomes, type QueryGenerationOutcome } from '../generation/metrics'
import { buildBaselineContext, compareArms, comparabilityOf, type ArmSummary } from './context'

config({ path: '.env.local', quiet: true })

/**
 * Phase 2E, master doc sections 14 and 18 — baseline versus RAG.
 *
 * The experiment that decides whether the retrieval half of this project earns its keep.
 * Same corpus, same queries, same model, same validation and the same judge; the ONLY
 * difference is what goes into the context window.
 *
 *   baseline: the whole document, ungated
 *   rag:      structure-aware chunks -> vector + BM25 -> RRF -> relevance floor
 *
 * Retrieval metrics are reported for the RAG arm only. The master doc is explicit that a
 * "retrieval score" for an arm that does no retrieval would be manufactured.
 */

const EVIDENCE_TOP_K = 8
const DEFAULT_RPM = 8
const RPM = Number(process.env.EVAL_RPM) > 0 ? Number(process.env.EVAL_RPM) : DEFAULT_RPM
const MIN_INTERVAL_MS = Math.ceil(60_000 / RPM)
const MAX_MINUTES = Number(process.env.EVAL_MAX_MINUTES) > 0 ? Number(process.env.EVAL_MAX_MINUTES) : 45

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
class BudgetExceeded extends Error {}

function createGovernor(maxCalls: number) {
  let nextAt = 0, calls = 0
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
    run<T>(fn: () => Promise<T>): Promise<T> {
      const task = chain.then(async () => { await gate(); return fn() })
      chain = task.catch(() => {})
      return task as Promise<T>
    },
    wrap(client: GenerateFn): GenerateFn {
      return (args) => {
        const task = chain.then(async () => { await gate(); return client(args) })
        chain = task.catch(() => {})
        return task as ReturnType<GenerateFn>
      }
    },
  }
}

function summarise(outcomes: QueryGenerationOutcome[]): ArmSummary {
  const m = scoreGenerationOutcomes(outcomes)
  return {
    groundedRate: m.groundedRate,
    supportedGenerationRate: m.supportedGenerationRate,
    schemaValidRate: m.schemaValidRate,
    unsupportedGenerationCount: m.unsupportedGenerationCount,
    supportedGenerationCount: m.supportedGenerationCount,
    meanLatencyMs: m.avgLatencyMs,
    evaluableQueries: m.evaluableQueries,
    inconclusiveCount: m.inconclusiveCount,
  }
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`

async function main(): Promise<void> {
  const corpusId = process.argv[2] ?? CORPUS_DOCUMENTS[0].id
  const doc = CORPUS_DOCUMENTS.find((d) => d.id === corpusId)
  if (!doc) {
    console.error(`Unknown document. Available: ${CORPUS_DOCUMENTS.map((d) => d.id).join(', ')}`)
    process.exit(2)
  }
  const limit = Number(process.env.EVAL_QUERIES) > 0 ? Number(process.env.EVAL_QUERIES) : Infinity
  const queries = GOLDEN_QUERIES.filter((q) => q.documentId === doc.id).slice(0, limit)
  const ownerId = process.env.EVAL_OWNER_ID || EVAL_OWNER_ID
  const fullText = corpusFullText(doc)

  const baselineCtx = buildBaselineContext(fullText)
  const comparability = comparabilityOf(baselineCtx)

  // Both arms per query: 2 slide attempts + 2 judge calls each, plus one embedding for RAG.
  const projected = queries.length * (4 + 4 + 1)
  const callCap = Number(process.env.EVAL_MAX_CALLS) > 0 ? Number(process.env.EVAL_MAX_CALLS) : projected + 10

  const runId = randomUUID().slice(0, 8)
  console.log('========== PHASE 2E: BASELINE vs RAG ==========')
  console.log(`Run ID   : ${runId}`)
  console.log(`Document : ${doc.id}, ${queries.length} queries, both arms`)
  console.log(`Budget   : <= ${projected} model calls at ${RPM} req/min; cap ${callCap} / ${MAX_MINUTES} min`)
  console.log(`Baseline : ${baselineCtx.originalTokens} tokens, ${baselineCtx.truncated ? 'TRUNCATED' : 'fits whole'}`)
  console.log(`           ${comparability.reason}\n`)

  const governor = createGovernor(callCap)
  const client = governor.wrap(createGenerateClient())
  const retriever = await createRetriever(evalDocumentId(doc.id), ownerId)
  if (retriever.chunkCount() === 0) {
    console.error(`Document ${doc.id} has no chunks for owner ${ownerId}. Run npm run eval:seed first.`)
    process.exit(2)
  }

  const baselineOutcomes: QueryGenerationOutcome[] = []
  const ragOutcomes: QueryGenerationOutcome[] = []

  for (const q of queries) {
    process.stdout.write(`  [${q.id}] ${q.category.padEnd(18)} baseline... `)
    const b = await evaluateQueryGeneration(q, doc, fullText, baselineCtx.evidence, client)
    baselineOutcomes.push(b)
    process.stdout.write(`${b.finalSlide ? 'OK' : b.abstentionClass.toUpperCase()}  rag... `)

    const evidence = await governor.run(() => retriever.retrieve(q.query, EVIDENCE_TOP_K))
    const r = await evaluateQueryGeneration(q, doc, fullText, evidence, client)
    ragOutcomes.push(r)
    console.log(r.finalSlide ? 'OK' : r.abstentionClass.toUpperCase())
  }

  const baseline = summarise(baselineOutcomes)
  const rag = summarise(ragOutcomes)
  const deltas = compareArms(baseline, rag)

  console.log('\n---------- BASELINE vs RAG ----------')
  console.log('  Metric                   Baseline        RAG          Delta')
  for (const d of deltas) {
    const fmt = (x: number) => (d.metric.includes('latency') || d.metric.includes('unsupported') ? x.toFixed(0) : pct(x))
    const sign = d.delta > 0 ? '+' : ''
    console.log(`  ${d.metric.padEnd(24)} ${fmt(d.baseline).padEnd(15)} ${fmt(d.rag).padEnd(12)} ${sign}${fmt(d.delta)}`)
  }
  console.log(`\n  Retrieval metrics apply to the RAG arm only; the baseline does no retrieval.`)
  console.log(`  Inconclusive: baseline ${baseline.inconclusiveCount}, rag ${rag.inconclusiveCount}`)

  if (!comparability.publishable) {
    console.log(`\n  NOT PUBLISHABLE as "PDF -> LLM versus Atlas RAG":`)
    console.log(`  ${comparability.reason}`)
  }

  mkdirSync('eval-results/baseline', { recursive: true })
  writeFileSync(
    'eval-results/baseline/latest.json',
    JSON.stringify(
      {
        runId, timestamp: new Date().toISOString(),
        corpusVersion: CORPUS_VERSION, goldenSetVersion: GOLDEN_SET_VERSION,
        documentId: doc.id, model: generationConfig(),
        baselineContext: {
          originalTokens: baselineCtx.originalTokens, usedTokens: baselineCtx.usedTokens,
          truncated: baselineCtx.truncated, droppedFraction: baselineCtx.droppedFraction,
        },
        comparability, arms: { baseline, rag }, deltas,
        providerCalls: governor.callsUsed(),
      },
      null, 2,
    ) + '\n',
  )
  console.log('\n  wrote eval-results/baseline/latest.json')

  if (baseline.inconclusiveCount > 0 || rag.inconclusiveCount > 0) {
    console.log('\n  WARNING: an arm has inconclusive queries. Deltas across arms with different')
    console.log('  reachability are not a fair comparison — re-run before citing them.')
    process.exit(2)
  }
}

main().catch((err) => {
  if (err instanceof BudgetExceeded) {
    console.error(`\nABORTED — ${err.message}`)
    console.error('No artifact written.')
    process.exit(3)
  }
  console.error('Baseline evaluation failed:', err)
  process.exit(1)
})
