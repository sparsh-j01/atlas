import { describe, expect, it } from 'vitest'
import { GOLDEN_QUERIES } from '../documents/golden-queries'
import { CORPUS_DOCUMENTS, corpusFullText } from '../documents/openstax-corpus'
import { firstOverlapRank, spanToInterval, type GoldInterval, type RetrievedChunk } from './evidence'
import { chunkDocument, type ChunkResult, type IdentifiedSection } from '@/lib/ai/chunk'
import { createBM25Index } from '@/lib/ai/bm25'

// CORPUS ACCEPTANCE GATES — the checks that decide whether a benchmark can mean anything,
// run BEFORE any real retrieval metric is trusted. Both gates here are FREE: no API key, no
// database, no embeddings. They exist because the previous corpus passed every threshold in
// the suite while measuring nothing, and nobody noticed for two milestones.
//
//   Gate 1  a random-permutation retriever must FAIL.
//           On the old 3-chunk corpus it scored recall@5 = recall@10 = 1.000, because
//           retrieve(query, 10) over 3 chunks returns everything. If shuffling the corpus
//           still passes, the metric is measuring corpus size, not ranking.
//
//   Gate 2  BM25-only must NOT be perfect.
//           On the old corpus BM25 alone scored 9/9 at rank 1, MRR 1.000 — so the entire
//           pgvector + RRF architecture had zero measurable headroom over keyword search.
//
// Gate 2 is a TRIPWIRE, not proof. It can pass for bad reasons (one malformed query is
// enough). Gates 3 and 4 from the master doc — arm disagreement and oracle headroom — are
// the real evidence, and both need embeddings, so they cannot run here.

function sectionsOf(doc: (typeof CORPUS_DOCUMENTS)[number]): IdentifiedSection[] {
  let off = 0
  return doc.pages.map((p, i) => {
    const s = {
      id: `${doc.id}-sec-${i}`, heading: doc.sectionTitles[i] ?? `S${i}`,
      pageStart: i + 1, pageEnd: i + 1, startOffset: off, endOffset: off + p.length,
    }
    off += p.length + 2
    return s
  })
}

const toRetrieved = (c: ChunkResult, i: number): RetrievedChunk => ({
  chunkId: String(i), charStart: c.charStart, charEnd: c.charEnd, text: c.text, similarity: null,
})

/** Deterministic PRNG so the "random" arm is reproducible across runs and machines. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffled<T>(items: T[], rand: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

interface ArmScore {
  recallAt5: number
  recallAt8: number
  recallAt10: number
  mrr: number
  graded: number
}

function score(ranks: number[]): ArmScore {
  const n = ranks.length
  const within = (k: number) => ranks.filter((r) => r > 0 && r <= k).length / n
  return {
    recallAt5: within(5),
    recallAt8: within(8),
    recallAt10: within(10),
    // A miss contributes 0 rather than being skipped.
    mrr: ranks.reduce((s, r) => s + (r > 0 ? 1 / r : 0), 0) / n,
    graded: n,
  }
}

/** Reported K values. Recall@8 is the one that predicts production: EVIDENCE_TOP_K = 8. */
const TOP_K = 10

async function armsFor(docId: string) {
  const doc = CORPUS_DOCUMENTS.find((d) => d.id === docId)!
  const full = corpusFullText(doc)
  const chunks = await chunkDocument(full, sectionsOf(doc))
  const retrieved = chunks.map(toRetrieved)
  const bm25 = createBM25Index(chunks.map((c, i) => ({ id: String(i), text: c.text, tokenCount: c.tokenCount })))

  const gradable = GOLDEN_QUERIES.filter((q) => q.documentId === docId && q.evidenceSpans.length > 0)
  const evidence = new Map<string, GoldInterval[]>(
    gradable.map((q) => [
      q.id,
      q.evidenceSpans.map((s) => {
        const r = spanToInterval(full, s)
        if (!r.ok) throw new Error(`${q.id}: ${r.error}`)
        return r.value
      }),
    ]),
  )

  const rand = mulberry32(0xa71a5) // fixed seed: the random arm must be reproducible
  const randomRanks: number[] = []
  const bm25Ranks: number[] = []
  for (const q of gradable) {
    const ev = evidence.get(q.id)!
    randomRanks.push(firstOverlapRank(shuffled(retrieved, rand).slice(0, TOP_K), ev))
    const top = bm25.search(q.query, TOP_K).map((r) => retrieved[Number(r.documentId)])
    bm25Ranks.push(firstOverlapRank(top, ev))
  }
  return { chunks: chunks.length, random: score(randomRanks), bm25: score(bm25Ranks) }
}

describe.each(CORPUS_DOCUMENTS.map((d) => [d.id] as const))('acceptance gates: %s', (docId) => {
  it('GATE 1: a random-permutation retriever FAILS', async () => {
    const { random, chunks } = await armsFor(docId)
    // With 60-100 chunks and K=10, a shuffle can only reach ~10/chunks of the corpus, so
    // these should be far from 1.0. On the old 3-chunk corpus they were exactly 1.0.
    expect(random.recallAt10, `random recall@10 over ${chunks} chunks`).toBeLessThan(0.5)
    expect(random.mrr).toBeLessThan(0.5)
  })

  it('GATE 2: BM25-only is NOT perfect on the ranking metric', async () => {
    // MRR, not recall@K, is the metric this gate has to protect.
    //
    // MEASURED, v1: BM25 MRR is 0.845 / 0.810 / 0.679 across the three documents, so there
    // is 0.16-0.32 of ranking headroom for a dense or fused arm to capture. That is the
    // headroom the whole M7 architecture claims to provide, and it is now measurable.
    //
    // KNOWN LIMITATION, recorded rather than hidden: BM25 recall@5 and recall@10 are 1.000
    // on social-psychology and big-bang. That is NOT the v0 pathology — v0's 1.000 came
    // from returning a 3-chunk corpus in its entirety, whereas top-10 of 67 chunks is 15%
    // of the document — but it does mean recall@K cannot discriminate the arms on those two
    // documents, and only MRR can. The cause is that queries authored FROM a passage
    // inherit its vocabulary. patent-enforcement, whose queries came out hardest
    // (recall 0.846, two outright BM25 misses), is the model for v2.
    const { bm25 } = await armsFor(docId)
    expect(bm25.mrr, 'BM25 MRR').toBeLessThan(1)
  })

  it('GATE 2b: recall is not ceilinged across the WHOLE corpus', async () => {
    // If BM25 achieved recall 1.000 on every document, recall@K would be dead as a metric
    // and the suite would be back to measuring nothing with it. At least one document must
    // keep headroom.
    const all = await Promise.all(CORPUS_DOCUMENTS.map((d) => armsFor(d.id)))
    expect(Math.min(...all.map((a) => a.bm25.recallAt10)), 'best-case BM25 recall@10 across corpus').toBeLessThan(1)
  })

  it('reports the measured arm scores', async () => {
    const { chunks, random, bm25 } = await armsFor(docId)
    const fmt = (a: ArmScore) =>
      `r@5=${a.recallAt5.toFixed(3)} r@8=${a.recallAt8.toFixed(3)} r@10=${a.recallAt10.toFixed(3)} mrr=${a.mrr.toFixed(3)} n=${a.graded}`
    console.log(`\n  ${docId}  (${chunks} chunks)`)
    console.log(`    random : ${fmt(random)}`)
    console.log(`    bm25   : ${fmt(bm25)}`)
    // BM25 must beat random by a real margin, or the queries are not answerable at all.
    expect(bm25.mrr).toBeGreaterThan(random.mrr)
  })
})
