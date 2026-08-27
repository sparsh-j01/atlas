import { config } from 'dotenv'
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRetriever, hasRelevantContext, RELEVANCE_FLOOR } from '@/lib/ai/retrieve'
import { embeddingConfig, EMBEDDING_DIMENSION } from '@/lib/ai/embed'
import { GOLDEN_QUERIES, GOLDEN_SET_VERSION } from './documents/golden-queries'
import { CORPUS_DOCUMENTS, CORPUS_VERSION, corpusFullText, type CorpusDocument } from './documents/openstax-corpus'
import { EVAL_OWNER_ID, evalDocumentId } from './seed-ids'
import { gradeQueries, type GradeRun } from './retrieval/grade'
import { scoreByCategory, scoreOutcomes, type QueryOutcome, type RetrievalMetrics } from './retrieval/metrics'
import { createArmRetriever, POOL_CONFIGS, type EvalArm, type EvalRunMode } from './retrieval/arms'

config({ path: '.env.local', quiet: true })

const REPORT_TOP_K = 10

export interface Gate3Result {
  passed: boolean
  vectorOnlyWins: { queryId: string; category: string; query: string; vectorRank: number; bm25Rank: number }[]
  bm25OnlyWins: { queryId: string; category: string; query: string; bm25Rank: number; vectorRank: number }[]
}

export interface Gate4Result {
  passed: boolean
  oracleMetrics: RetrievalMetrics
  vectorMetrics: RetrievalMetrics
  bm25Metrics: RetrievalMetrics
  hybridMetrics: RetrievalMetrics
  oracleHeadroomAt8: number
  oracleHeadroomAt10: number
  oracleHeadroomMrr: number
}

export interface DocumentArmBenchmark {
  corpusId: string
  documentId: string
  chunkCount: number
  arm: EvalArm
  runMode: EvalRunMode
  metrics: RetrievalMetrics
  categoryMetrics: Record<string, RetrievalMetrics>
  outcomes: QueryOutcome[]
  negatives: { abstained: boolean }[]
}

export interface FullBenchmarkRun {
  runId: string
  timestamp: string
  corpusVersion: string
  goldenSetVersion: string
  embedding: ReturnType<typeof embeddingConfig>
  relevanceFloor: number
  reportTopK: number
  documents: {
    corpusId: string
    documentId: string
    chunkCount: number
  }[]
  runs: {
    runA: {
      mode: 'runA'
      description: string
      perDocument: Record<string, Record<EvalArm, DocumentArmBenchmark>>
      pooled: Record<EvalArm, RetrievalMetrics>
      gate3: Gate3Result
      gate4: Gate4Result
    }
    runB: {
      mode: 'runB'
      description: string
      perDocument: Record<string, Record<EvalArm, DocumentArmBenchmark>>
      pooled: Record<EvalArm, RetrievalMetrics>
      gate3: Gate3Result
      gate4: Gate4Result
    }
  }
}

function computeGate3(vectorOutcomes: QueryOutcome[], bm25Outcomes: QueryOutcome[]): Gate3Result {
  const bm25Map = new Map(bm25Outcomes.map((o) => [o.query.id, o]))
  const vectorOnlyWins: Gate3Result['vectorOnlyWins'] = []
  const bm25OnlyWins: Gate3Result['bm25OnlyWins'] = []

  for (const v of vectorOutcomes) {
    const b = bm25Map.get(v.query.id)
    if (!b) continue
    const vHit = v.rank > 0 && v.rank <= REPORT_TOP_K
    const bHit = b.rank > 0 && b.rank <= REPORT_TOP_K

    if (vHit && !bHit) {
      vectorOnlyWins.push({
        queryId: v.query.id,
        category: v.query.category,
        query: v.query.query,
        vectorRank: v.rank,
        bm25Rank: b.rank,
      })
    } else if (bHit && !vHit) {
      bm25OnlyWins.push({
        queryId: b.query.id,
        category: b.query.category,
        query: b.query.query,
        bm25Rank: b.rank,
        vectorRank: v.rank,
      })
    }
  }

  return {
    passed: vectorOnlyWins.length > 0 && bm25OnlyWins.length > 0,
    vectorOnlyWins,
    bm25OnlyWins,
  }
}

function computeGate4(
  vectorOutcomes: QueryOutcome[],
  bm25Outcomes: QueryOutcome[],
  hybridOutcomes: QueryOutcome[],
  negatives: { abstained: boolean }[],
): Gate4Result {
  const bm25Map = new Map(bm25Outcomes.map((o) => [o.query.id, o]))
  const oracleOutcomes: QueryOutcome[] = vectorOutcomes.map((v) => {
    const b = bm25Map.get(v.query.id)
    const bRank = b ? b.rank : 0
    const vRank = v.rank

    let oracleRank = 0
    if (vRank > 0 && bRank > 0) {
      oracleRank = Math.min(vRank, bRank)
    } else if (vRank > 0) {
      oracleRank = vRank
    } else if (bRank > 0) {
      oracleRank = bRank
    }

    const covered = v.covered || (b ? b.covered : false)
    const latencyMs = Math.min(v.latencyMs, b ? b.latencyMs : v.latencyMs)
    const topSim = v.topSimilarity

    return {
      query: v.query,
      rank: oracleRank,
      covered,
      latencyMs,
      topSimilarity: topSim,
    }
  })

  const oracleMetrics = scoreOutcomes(oracleOutcomes, negatives)
  const vectorMetrics = scoreOutcomes(vectorOutcomes, negatives)
  const bm25Metrics = scoreOutcomes(bm25Outcomes, negatives)
  const hybridMetrics = scoreOutcomes(hybridOutcomes, negatives)

  const maxSingleRecallAt8 = Math.max(vectorMetrics.recallAt8, bm25Metrics.recallAt8)
  const maxSingleRecallAt10 = Math.max(vectorMetrics.recallAt10, bm25Metrics.recallAt10)
  const maxSingleMrr = Math.max(vectorMetrics.mrr, bm25Metrics.mrr)

  const oracleHeadroomAt8 = oracleMetrics.recallAt8 - maxSingleRecallAt8
  const oracleHeadroomAt10 = oracleMetrics.recallAt10 - maxSingleRecallAt10
  const oracleHeadroomMrr = oracleMetrics.mrr - maxSingleMrr

  return {
    passed: oracleHeadroomAt10 >= 0 && oracleHeadroomMrr > 0,
    oracleMetrics,
    vectorMetrics,
    bm25Metrics,
    hybridMetrics,
    oracleHeadroomAt8,
    oracleHeadroomAt10,
    oracleHeadroomMrr,
  }
}

async function evaluateDocumentArms(
  doc: CorpusDocument,
  ownerId: string,
  documentId: string,
): Promise<{
  chunkCount: number
  runs: Record<EvalRunMode, Record<EvalArm, DocumentArmBenchmark>>
}> {
  const fullText = corpusFullText(doc)
  const queries = GOLDEN_QUERIES.filter((q) => q.documentId === doc.id)
  const retriever = await createRetriever(documentId, ownerId)
  const chunkCount = retriever.chunkCount()

  if (chunkCount === 0) {
    throw new Error(`Document ${documentId} (${doc.id}) has no chunks or is not owned by ${ownerId}. Seed it first.`)
  }

  const runs: Record<EvalRunMode, Record<EvalArm, DocumentArmBenchmark>> = {
    runA: {} as Record<EvalArm, DocumentArmBenchmark>,
    runB: {} as Record<EvalArm, DocumentArmBenchmark>,
  }

  for (const mode of ['runA', 'runB'] as EvalRunMode[]) {
    for (const arm of ['vector', 'bm25', 'hybrid'] as EvalArm[]) {
      const poolConfig = POOL_CONFIGS[mode][arm]
      const armRetriever = createArmRetriever(retriever, poolConfig)

      const gradeRun: GradeRun = await gradeQueries(armRetriever, queries, fullText, {
        topK: REPORT_TOP_K,
        label: doc.id,
        isRelevant: (results) => hasRelevantContext(results).ok,
      })

      const metrics = scoreOutcomes(gradeRun.graded, gradeRun.negatives)
      const catMap = scoreByCategory(gradeRun.graded)
      const categoryMetrics: Record<string, RetrievalMetrics> = {}
      for (const [cat, m] of catMap.entries()) {
        categoryMetrics[cat] = m
      }

      runs[mode][arm] = {
        corpusId: doc.id,
        documentId,
        chunkCount,
        arm,
        runMode: mode,
        metrics,
        categoryMetrics,
        outcomes: gradeRun.graded,
        negatives: gradeRun.negatives,
      }
    }
  }

  return { chunkCount, runs }
}

function writeArtifacts(run: FullBenchmarkRun): { jsonPath: string; mdPath: string } {
  mkdirSync('eval-results/runs', { recursive: true })

  const safeTs = run.timestamp.replace(/[:.]/g, '-')
  const filenamePrefix = `${safeTs}-${run.runId}`
  const jsonPath = `eval-results/runs/${filenamePrefix}.json`
  const mdPath = `eval-results/runs/${filenamePrefix}.md`

  // Format JSON
  const jsonContent = JSON.stringify(run, null, 2)
  writeFileSync(jsonPath, jsonContent + '\n')
  writeFileSync('eval-results/latest.json', jsonContent + '\n')

  // Format Markdown
  const md = generateMarkdownReport(run)
  writeFileSync(mdPath, md + '\n')
  writeFileSync('eval-results/latest.md', md + '\n')

  return { jsonPath, mdPath }
}

/**
 * What Gate 3 actually licenses you to claim.
 *
 * Gate 3 is the gate that justifies hybrid retrieval existing: if neither arm wins anything
 * the other misses, fusing them cannot add ranking information. Reporting it as a bare
 * PASS/FAIL row invites the reader to skim past a FAIL and quote the hybrid number anyway,
 * so the interpretation is written out and derived from the measured numbers rather than
 * left to the reader.
 */
function generateGate3Interpretation(run: FullBenchmarkRun): string {
  const num = (v: number) => v.toFixed(3)
  const pct = (v: number) => (v * 100).toFixed(1) + '%'
  const r = run.runs.runA
  const { vectorOnlyWins, bm25OnlyWins } = r.gate3
  const v = r.pooled.vector
  const b = r.pooled.bm25
  const h = r.pooled.hybrid
  const bestSingle = v.mrr >= b.mrr ? { name: 'vector-only', m: v } : { name: 'BM25-only', m: b }
  const mrrDelta = h.mrr - bestSingle.m.mrr
  const recallDelta = h.recallAt8 - bestSingle.m.recallAt8

  let s = `### What Gate 3 licenses you to claim\n\n`

  if (r.gate3.passed) {
    s += `**Gate 3 PASSED.** Vector uniquely found ${vectorOnlyWins.length} ${vectorOnlyWins.length === 1 ? 'query' : 'queries'} BM25 missed, and BM25\n`
    s += `uniquely found ${bm25OnlyWins.length} that vector missed. The arms disagree, so fusion has real\n`
    s += `information to combine and hybrid retrieval is doing work neither arm does alone.\n\n`
  } else {
    s += `**Gate 3 FAILED, and the failure is load-bearing — do not skim past it.**\n\n`
    s += `Vector-only unique wins: **${vectorOnlyWins.length}**. BM25-only unique wins: **${bm25OnlyWins.length}**.\n\n`
    if (bm25OnlyWins.length === 0 && vectorOnlyWins.length > 0) {
      s += `BM25 found nothing the dense arm did not already find. Fusing a ranker that contributes no\n`
      s += `unique hits cannot add ranking information, so on THIS corpus hybrid retrieval is insurance,\n`
      s += `not lift.\n\n`
    } else if (vectorOnlyWins.length === 0 && bm25OnlyWins.length > 0) {
      s += `The dense arm found nothing BM25 did not already find — the reverse of the expected failure,\n`
      s += `and worth checking the embedder and task type (\`RETRIEVAL_QUERY\` vs \`RETRIEVAL_DOCUMENT\`)\n`
      s += `before concluding anything about fusion.\n\n`
    } else {
      s += `Neither arm contributed a unique win. Both are returning the same documents, so this corpus\n`
      s += `cannot discriminate the arms at all.\n\n`
    }
    s += `**The measured deltas say the same thing.** Hybrid MRR ${num(h.mrr)} vs ${bestSingle.name} ${num(bestSingle.m.mrr)}\n`
    s += `— a difference of ${mrrDelta >= 0 ? '+' : ''}${num(mrrDelta)}. Recall@8: ${pct(h.recallAt8)} vs ${pct(bestSingle.m.recallAt8)}\n`
    s += `(${recallDelta >= 0 ? '+' : ''}${pct(recallDelta)}).\n\n`
    s += `**Say this, not "hybrid retrieval was necessary":**\n\n`
    s += `> Dense retrieval saturates this corpus — Recall@8 is ${pct(v.recallAt8)} for vector alone. BM25\n`
    s += `> contributed no unique wins, so Gate 3 failed and is reported as failed. RRF fusion costs\n`
    s += `> nothing measurable and covers the vocabulary-mismatch case the corpus happens not to\n`
    s += `> contain, so it stays in — as insurance, not as demonstrated lift.\n\n`
    s += `That is a stronger answer than a manufactured win: it names the limit of the evidence and\n`
    s += `the engineering reason the component survives anyway. The honest follow-up is that a corpus\n`
    s += `with rarer surface forms (acronyms, identifiers, case citations) is where BM25 earns its\n`
    s += `place, and this corpus does not have enough of them — \`patent-enforcement\` came closest\n`
    s += `(BM25 recall@10 ${pct(r.perDocument['openstax-patent-enforcement']?.bm25.metrics.recallAt10 ?? 0)}) and is the model for a v2 golden set.\n\n`
  }
  return s
}

function generateMarkdownReport(run: FullBenchmarkRun): string {
  const fmt = (v: number | null) => (v === null ? 'N/A' : (v * 100).toFixed(1) + '%')
  const num = (v: number) => v.toFixed(3)
  const ms = (v: number | undefined | null) => (v === undefined || v === null ? '-' : v.toFixed(0) + 'ms')

  let doc = `# Atlas M7 Phase 2A Retrieval Evaluation Benchmark\n\n`
  doc += `**Run ID**: \`${run.runId}\`  \n`
  doc += `**Timestamp**: \`${run.timestamp}\`  \n`
  doc += `**Corpus Version**: \`${run.corpusVersion}\`  \n`
  doc += `**Golden Set Version**: \`${run.goldenSetVersion}\`  \n`
  doc += `**Embedder**: \`${run.embedding.model}\` (${run.embedding.dimension} dim)  \n`
  doc += `**Relevance Floor**: \`${run.relevanceFloor}\`  \n\n`

  doc += `## 1. Executive Summary & Acceptance Gates\n\n`
  doc += `### Acceptance Gates (Phase 2A)\n\n`
  doc += `| Gate | Description | Status | Details |\n`
  doc += `|---|---|---|---|\n`
  doc += `| **Gate 1** | Random baseline fails | see footnote † | Not recomputed by this run |\n`
  doc += `| **Gate 2** | BM25 MRR < 1.000 (headroom exists) | see footnote † | Not recomputed by this run |\n`
  doc += `| **Gate 3 (Run A)** | Arm Disagreement (Mutual unique wins) | **${run.runs.runA.gate3.passed ? 'PASS' : 'FAIL'}** | Vector wins: ${run.runs.runA.gate3.vectorOnlyWins.length}, BM25 wins: ${run.runs.runA.gate3.bm25OnlyWins.length} |\n`
  doc += `| **Gate 3 (Run B)** | Arm Disagreement (Budget-normalized) | **${run.runs.runB.gate3.passed ? 'PASS' : 'FAIL'}** | Vector wins: ${run.runs.runB.gate3.vectorOnlyWins.length}, BM25 wins: ${run.runs.runB.gate3.bm25OnlyWins.length} |\n`
  doc += `| **Gate 4 (Run A)** | Oracle Union > Single Arms | **${run.runs.runA.gate4.passed ? 'PASS' : 'FAIL'}** | Oracle MRR ${num(run.runs.runA.gate4.oracleMetrics.mrr)} vs Max Single ${num(Math.max(run.runs.runA.gate4.vectorMetrics.mrr, run.runs.runA.gate4.bm25Metrics.mrr))} (Headroom: +${num(run.runs.runA.gate4.oracleHeadroomMrr)}) |\n`
  doc += `| **Gate 4 (Run B)** | Oracle Union > Single Arms (Budget-norm) | **${run.runs.runB.gate4.passed ? 'PASS' : 'FAIL'}** | Oracle MRR ${num(run.runs.runB.gate4.oracleMetrics.mrr)} vs Max Single ${num(Math.max(run.runs.runB.gate4.vectorMetrics.mrr, run.runs.runB.gate4.bm25Metrics.mrr))} (Headroom: +${num(run.runs.runB.gate4.oracleHeadroomMrr)}) |\n\n`

  doc += `† **Gates 1 and 2 are verified in \`evals/retrieval/acceptance.test.ts\`, not by this run.**\n`
  doc += `They need no API key and no database, so they live in the unit suite and run in CI on every\n`
  doc += `change. This benchmark previously printed them as \`PASS (Unit Verified)\` with their numbers\n`
  doc += `baked into the template — an assertion, not a measurement, which would have kept printing PASS\n`
  doc += `after a corpus change that broke them. Run \`npx vitest run evals/retrieval/acceptance.test.ts\`\n`
  doc += `for the current values.\n\n`

  doc += generateGate3Interpretation(run)

  for (const mode of ['runA', 'runB'] as const) {
    const r = run.runs[mode]
    doc += `## 2. ${mode === 'runA' ? 'Run A: Production Fidelity (Vector top-20, BM25 top-20, Hybrid top-40 fused)' : 'Run B: Budget-Normalized Comparison (Vector top-40, BM25 top-40, Hybrid top-40 fused)'}\n\n`
    doc += `### Pooled Retrieval Performance across All 3 OpenStax Documents (n=40 gradable queries)\n\n`
    doc += `| Arm | Recall@5 | Recall@8 (Prod) | Recall@10 | MRR | All-Evidence@8 | Total Latency | P95 Latency |\n`
    doc += `|---|---|---|---|---|---|---|---|\n`
    for (const arm of ['vector', 'bm25', 'hybrid'] as const) {
      const m = r.pooled[arm]
      doc += `| **${arm.toUpperCase()}** | ${fmt(m.recallAt5)} | ${fmt(m.recallAt8)} | ${fmt(m.recallAt10)} | ${num(m.mrr)} | ${fmt(m.allEvidenceRecallAt8)} | ${ms(m.avgLatencyMs)} | ${ms(m.p95LatencyMs)} |\n`
    }
    const o = r.gate4.oracleMetrics
    doc += `| *ORACLE (Ceiling)* | *${fmt(o.recallAt5)}* | *${fmt(o.recallAt8)}* | *${fmt(o.recallAt10)}* | *${num(o.mrr)}* | *${fmt(o.allEvidenceRecallAt8)}* | - | - |\n\n`

    doc += `### Decomposed Latency Breakdown (${mode})\n\n`
    doc += `| Arm | Total Latency | Embedding/API (Cold) | DB Search (Warm) | Cache Hits | Cache Misses |\n`
    doc += `|---|---|---|---|---|---|\n`
    for (const arm of ['vector', 'bm25', 'hybrid'] as const) {
      const m = r.pooled[arm]
      doc += `| **${arm.toUpperCase()}** | ${ms(m.avgLatencyMs)} | ${ms(m.avgEmbeddingMs)} | ${ms(m.avgSearchMs)} | ${m.cacheHits ?? 0} | ${m.cacheMisses ?? 0} |\n`
    }
    doc += `\n> **Latency note — do NOT compare Run A and Run B latency.** \`createRetriever\` holds a\n`
    doc += `> per-instance query-vector cache (\`lib/ai/retrieve.ts\`, \`queryVectorCache\`). Run A executes\n`
    doc += `> first against the same retriever instance and pays the live Gemini embedding hop on every\n`
    doc += `> query; Run B reads those vectors back from the cache. Any Run A → Run B "speedup" in the\n`
    doc += `> Total Latency column is **run order, not pool size** — the pool configuration changes what\n`
    doc += `> pgvector scans, not what the embedding call costs. The Embedding/API and DB Search columns\n`
    doc += `> above are the ones that decompose it: embedding is the HTTPS hop (~450-550ms cold, 0ms\n`
    doc += `> cached), DB Search is pgvector SQL (~65-85ms), and BM25 is in-memory (<1ms). Quote the\n`
    doc += `> decomposed columns or the Cache Hits/Misses counts, never the totals side by side.\n\n`

    doc += `### Per-Document Breakdown\n\n`
    for (const docInfo of run.documents) {
      doc += `#### Document: \`${docInfo.corpusId}\` (${docInfo.chunkCount} chunks)\n\n`
      doc += `| Arm | Recall@5 | Recall@8 | Recall@10 | MRR | All-Evidence@8 | Total Latency |\n`
      doc += `|---|---|---|---|---|---|---|\n`
      for (const arm of ['vector', 'bm25', 'hybrid'] as const) {
        const m = r.perDocument[docInfo.corpusId][arm].metrics
        doc += `| ${arm} | ${fmt(m.recallAt5)} | ${fmt(m.recallAt8)} | ${fmt(m.recallAt10)} | ${num(m.mrr)} | ${fmt(m.allEvidenceRecallAt8)} | ${ms(m.avgLatencyMs)} |\n`
      }
      doc += `\n`
    }

    doc += `### Gate 3 Analysis: Mutual Unique Wins (${mode})\n\n`
    doc += `#### Vector-Only Unique Wins (Vector in top-10, BM25 missed)\n`
    if (r.gate3.vectorOnlyWins.length === 0) {
      doc += `*None*\n\n`
    } else {
      doc += `| Query ID | Category | Query | Vector Rank | BM25 Rank |\n|---|---|---|---|---|\n`
      for (const w of r.gate3.vectorOnlyWins) {
        doc += `| \`${w.queryId}\` | ${w.category} | ${w.query} | ${w.vectorRank} | ${w.bm25Rank === 0 ? 'MISS' : w.bm25Rank} |\n`
      }
      doc += `\n`
    }

    doc += `#### BM25-Only Unique Wins (BM25 in top-10, Vector missed)\n`
    if (r.gate3.bm25OnlyWins.length === 0) {
      doc += `*None*\n\n`
    } else {
      doc += `| Query ID | Category | Query | BM25 Rank | Vector Rank |\n|---|---|---|---|---|\n`
      for (const w of r.gate3.bm25OnlyWins) {
        doc += `| \`${w.queryId}\` | ${w.category} | ${w.query} | ${w.bm25Rank} | ${w.vectorRank === 0 ? 'MISS' : w.vectorRank} |\n`
      }
      doc += `\n`
    }
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
  console.log(`Starting Phase 2A Retrieval Benchmark (Run ID: ${runId})`)
  console.log(`Targeting ${targetDocs.length} documents for owner ${ownerId}...`)

  const docSummaries: FullBenchmarkRun['documents'] = []
  const docResults: {
    corpusId: string
    documentId: string
    chunkCount: number
    runs: Record<EvalRunMode, Record<EvalArm, DocumentArmBenchmark>>
  }[] = []

  for (const doc of targetDocs) {
    const docId = evalDocumentId(doc.id)
    console.log(`Evaluating ${doc.id} (${docId})...`)
    const res = await evaluateDocumentArms(doc, ownerId, docId)
    docSummaries.push({ corpusId: doc.id, documentId: docId, chunkCount: res.chunkCount })
    docResults.push({ corpusId: doc.id, documentId: docId, chunkCount: res.chunkCount, runs: res.runs })
  }

  // Aggregate Pooled Metrics and Gates for Run A and Run B
  const runA_perDoc: Record<string, Record<EvalArm, DocumentArmBenchmark>> = {}
  const runB_perDoc: Record<string, Record<EvalArm, DocumentArmBenchmark>> = {}

  for (const d of docResults) {
    runA_perDoc[d.corpusId] = d.runs.runA
    runB_perDoc[d.corpusId] = d.runs.runB
  }

  function aggregatePooled(mode: EvalRunMode) {
    const pooledOutcomes: Record<EvalArm, QueryOutcome[]> = { vector: [], bm25: [], hybrid: [] }
    const pooledNegatives: Record<EvalArm, { abstained: boolean }[]> = { vector: [], bm25: [], hybrid: [] }

    for (const d of docResults) {
      for (const arm of ['vector', 'bm25', 'hybrid'] as EvalArm[]) {
        pooledOutcomes[arm].push(...d.runs[mode][arm].outcomes)
        pooledNegatives[arm].push(...d.runs[mode][arm].negatives)
      }
    }

    const pooledMetrics: Record<EvalArm, RetrievalMetrics> = {
      vector: scoreOutcomes(pooledOutcomes.vector, pooledNegatives.vector),
      bm25: scoreOutcomes(pooledOutcomes.bm25, pooledNegatives.bm25),
      hybrid: scoreOutcomes(pooledOutcomes.hybrid, pooledNegatives.hybrid),
    }

    const gate3 = computeGate3(pooledOutcomes.vector, pooledOutcomes.bm25)
    const gate4 = computeGate4(pooledOutcomes.vector, pooledOutcomes.bm25, pooledOutcomes.hybrid, pooledNegatives.vector)

    return { pooledMetrics, gate3, gate4 }
  }

  const runA_agg = aggregatePooled('runA')
  const runB_agg = aggregatePooled('runB')

  const fullBenchmark: FullBenchmarkRun = {
    runId,
    timestamp,
    corpusVersion: CORPUS_VERSION,
    goldenSetVersion: GOLDEN_SET_VERSION,
    embedding: { ...embeddingConfig(), dimension: EMBEDDING_DIMENSION },
    relevanceFloor: RELEVANCE_FLOOR,
    reportTopK: REPORT_TOP_K,
    documents: docSummaries,
    runs: {
      runA: {
        mode: 'runA',
        description: 'Production fidelity: Vector 20, BM25 20, Hybrid 20+20',
        perDocument: runA_perDoc,
        pooled: runA_agg.pooledMetrics,
        gate3: runA_agg.gate3,
        gate4: runA_agg.gate4,
      },
      runB: {
        mode: 'runB',
        description: 'Budget-normalized: Vector 40, BM25 40, Hybrid 20+20',
        perDocument: runB_perDoc,
        pooled: runB_agg.pooledMetrics,
        gate3: runB_agg.gate3,
        gate4: runB_agg.gate4,
      },
    },
  }

  const { jsonPath, mdPath } = writeArtifacts(fullBenchmark)
  console.log(`\n================ BENCHMARK COMPLETED ================`)
  console.log(`Run ID: ${runId}`)
  console.log(`Artifacts written:`)
  console.log(`  JSON: ${jsonPath} (and eval-results/latest.json)`)
  console.log(`  MD:   ${mdPath} (and eval-results/latest.md)\n`)

  console.log(`POOLED RESULTS (Run A - Production Fidelity):`)
  console.log(`  VECTOR : Recall@8=${(runA_agg.pooledMetrics.vector.recallAt8 * 100).toFixed(1)}% MRR=${runA_agg.pooledMetrics.vector.mrr.toFixed(3)} Latency=${runA_agg.pooledMetrics.vector.avgLatencyMs.toFixed(0)}ms`)
  console.log(`  BM25   : Recall@8=${(runA_agg.pooledMetrics.bm25.recallAt8 * 100).toFixed(1)}% MRR=${runA_agg.pooledMetrics.bm25.mrr.toFixed(3)} Latency=${runA_agg.pooledMetrics.bm25.avgLatencyMs.toFixed(0)}ms`)
  console.log(`  HYBRID : Recall@8=${(runA_agg.pooledMetrics.hybrid.recallAt8 * 100).toFixed(1)}% MRR=${runA_agg.pooledMetrics.hybrid.mrr.toFixed(3)} Latency=${runA_agg.pooledMetrics.hybrid.avgLatencyMs.toFixed(0)}ms`)
  console.log(`  ORACLE : Recall@8=${(runA_agg.gate4.oracleMetrics.recallAt8 * 100).toFixed(1)}% MRR=${runA_agg.gate4.oracleMetrics.mrr.toFixed(3)}`)

  console.log(`\nACCEPTANCE GATES:`)
  console.log(`  Gate 3 (Arm Disagreement): ${runA_agg.gate3.passed ? 'PASS' : 'FAIL'} (Vector unique wins: ${runA_agg.gate3.vectorOnlyWins.length}, BM25 unique wins: ${runA_agg.gate3.bm25OnlyWins.length})`)
  console.log(`  Gate 4 (Oracle Headroom)  : ${runA_agg.gate4.passed ? 'PASS' : 'FAIL'} (Oracle MRR: ${runA_agg.gate4.oracleMetrics.mrr.toFixed(3)} vs Max Single: ${Math.max(runA_agg.gate4.vectorMetrics.mrr, runA_agg.gate4.bm25Metrics.mrr).toFixed(3)})`)
}

main().catch((err) => {
  console.error('Benchmark execution failed:', err)
  process.exit(1)
})
