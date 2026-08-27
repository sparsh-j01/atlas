import { config } from 'dotenv'
import { createRetriever, hasRelevantContext, RELEVANCE_FLOOR } from '@/lib/ai/retrieve'
import { GOLDEN_QUERIES } from './documents/golden-queries'
import { CORPUS_DOCUMENTS, CORPUS_VERSION, corpusFullText, getCorpusDocument } from './documents/openstax-corpus'
import { gradeQueries } from './retrieval/grade'
import { scoreByCategory, scoreOutcomes, type QueryOutcome, type RetrievalMetrics } from './retrieval/metrics'

// RAG retrieval evaluation harness (M7 phase 20).
//
//   EVAL_OWNER_ID=<uuid> npm run eval -- <ingestedDocumentId> <corpusDocId>
//
// Runs against a REAL ingested document, because the live pipeline — Gemini embeddings and
// pgvector included — is the only thing worth measuring. The ingested document must carry
// the pinned corpus text byte for byte: gold evidence is recorded as offsets into it, and
// `gradeQueries` refuses to grade a document whose chunk coordinates disagree.
//
// This file previously only EXPORTED functions with no top-level invocation, so
// `npm run eval` loaded the module, ran nothing and exited 0 — a green eval that had never
// executed a single query. `npm run eval` now also passes --conditions=react-server, so
// `import 'server-only'` resolves to the package's empty stub instead of the module that
// throws on sight; without it the harness died at import.
//
// ONE ARM. This measures hybrid retrieval (`createRetriever` fuses vector + BM25), which is
// what production runs. The three-arm comparison and the acceptance gates that need
// embeddings are a separate run; the two free gates live in `retrieval/acceptance.test.ts`.

// Same env file the app uses. Safe after the imports because `db` and `serverEnv` are both
// lazy — nothing reads a variable until the first query.
config({ path: '.env.local', quiet: true })

const REPORT_TOP_K = 10

function usage(): never {
  console.error('Usage: EVAL_OWNER_ID=<uuid> npm run eval -- <ingestedDocumentId> <corpusDocId>')
  console.error(`Corpus documents (${CORPUS_VERSION}): ${CORPUS_DOCUMENTS.map((d) => d.id).join(', ')}`)
  console.error('The ingested document must carry the pinned corpus text; gold offsets index into it.')
  process.exit(2)
}

async function main(): Promise<void> {
  const [documentId, corpusId] = process.argv.slice(2)
  const ownerId = process.env.EVAL_OWNER_ID
  if (!documentId || !corpusId || !ownerId) usage()

  const corpus = getCorpusDocument(corpusId)
  if (!corpus) {
    console.error(`Unknown corpus document "${corpusId}".`)
    usage()
  }

  const queries = GOLDEN_QUERIES.filter((q) => q.documentId === corpusId)
  if (queries.length === 0) {
    console.error(`No golden queries are written against "${corpusId}".`)
    process.exit(2)
  }

  const retriever = await createRetriever(documentId, ownerId)
  if (retriever.chunkCount() === 0) {
    console.error(`Document ${documentId} has no chunks (or is not owned by ${ownerId}). Ingest it first.`)
    process.exit(2)
  }

  const { graded, negatives } = await gradeQueries(retriever, queries, corpusFullText(corpus), {
    topK: REPORT_TOP_K,
    label: corpusId,
    isRelevant: (results) => hasRelevantContext(results).ok,
  })

  report(scoreOutcomes(graded, negatives), graded, corpusId, retriever.chunkCount())

  // Exits 0 on any completed run. The thresholds that used to gate this were invented before
  // the first measurement — see the note at the foot of retrieval/metrics.ts.
  console.log('\nMeasurement run. No thresholds are enforced yet; set them from this baseline.')
}

function report(m: RetrievalMetrics, graded: QueryOutcome[], corpusId: string, chunkCount: number): void {
  const pct = (v: number) => v.toFixed(3)
  console.log(`corpus ${corpusId} ${CORPUS_VERSION}   chunks indexed: ${chunkCount}   relevance floor: ${RELEVANCE_FLOOR}`)
  console.log(
    `recall@5 ${pct(m.recallAt5)}  recall@8 ${pct(m.recallAt8)}  recall@10 ${pct(m.recallAt10)}  ` +
      `MRR ${pct(m.mrr)}  all-evidence@8 ${pct(m.allEvidenceRecallAt8)}`,
  )
  console.log(
    `abstention ${m.correctAbstentions === null ? 'N/A: no negative examples' : pct(m.correctAbstentions)}` +
      ` (${m.negativeQueries} negatives)   latency avg ${m.avgLatencyMs.toFixed(0)}ms p95 ${m.p95LatencyMs.toFixed(0)}ms`,
  )

  // Per category, because the categories are the claims. A strong average with
  // semantic_paraphrase at zero means the dense half of the hybrid is contributing nothing.
  console.log('\nby category:')
  for (const [category, c] of scoreByCategory(graded)) {
    console.log(
      `  ${category.padEnd(20)} n=${String(c.gradedQueries).padEnd(3)} ` +
        `r@8 ${pct(c.recallAt8)}  MRR ${pct(c.mrr)}  all-evidence@8 ${pct(c.allEvidenceRecallAt8)}`,
    )
  }

  console.log('\nper query:')
  for (const o of graded) {
    const verdict = o.rank > 0 ? `rank ${o.rank}` : 'MISS'
    const sim = o.topSimilarity === null ? ' sim   - ' : ` sim ${o.topSimilarity.toFixed(2)}`
    console.log(
      `  ${o.query.id.padEnd(6)} ${o.query.category.padEnd(20)} ${verdict.padEnd(8)}` +
        `${o.covered ? ' full' : '     '}${sim}  ${o.latencyMs}ms  ${o.query.query}`,
    )
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
