// BM25 keyword scoring over one document's chunks (M7 phase 7).
//
// In app code rather than Postgres on purpose: Postgres `ts_rank` has no IDF term, so it
// is not a BM25 substitute, and `pg_search`/ParadeDB needs an extension managed Supabase
// does not host. The corpus is one document — hundreds of chunks, not millions — and the
// index is built once per generation run by lib/ai/retrieve.ts, so it stays in memory for
// the length of one request and is discarded.
// ponytail: fine at one document. If this ever ranks across a whole library, it moves to
// Postgres FTS or a dedicated search service rather than growing here.

export interface BM25Document {
  id: string
  text: string
  tokenCount: number
}

export interface BM25Result {
  documentId: string
  score: number
  rank: number
}

// Standard BM25 parameters. k1 damps term-frequency saturation, b controls how hard
// length normalisation bites.
const K1 = 1.2
const B = 0.75

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
}

export class BM25Index {
  private readonly docLengths = new Map<string, number>()
  private readonly termFreqs = new Map<string, Map<string, number>>()
  private readonly docFreqs = new Map<string, number>()
  private readonly avgDocLength: number

  constructor(docs: BM25Document[]) {
    // Built once from the whole corpus, so the average is one division at the end rather
    // than a full reduce over every document on each insert — that made indexing O(n²),
    // and the index was being rebuilt once per slide on top of it.
    let totalLength = 0
    for (const doc of docs) {
      this.docLengths.set(doc.id, doc.tokenCount)
      totalLength += doc.tokenCount

      const terms = tokenize(doc.text)
      const tf = new Map<string, number>()
      for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1)
      this.termFreqs.set(doc.id, tf)

      for (const term of new Set(terms)) this.docFreqs.set(term, (this.docFreqs.get(term) ?? 0) + 1)
    }
    this.avgDocLength = docs.length > 0 ? totalLength / docs.length : 0
  }

  get size(): number {
    return this.docLengths.size
  }

  search(query: string, topK: number): BM25Result[] {
    const queryTerms = tokenize(query)
    if (queryTerms.length === 0 || this.avgDocLength === 0) return []

    const scores: { id: string; score: number }[] = []
    for (const [docId, tf] of this.termFreqs) {
      const docLength = this.docLengths.get(docId) ?? 0
      let score = 0
      for (const term of queryTerms) {
        const freq = tf.get(term) ?? 0
        if (freq === 0) continue
        const df = this.docFreqs.get(term) ?? 0
        if (df === 0) continue
        const idf = Math.log((this.size - df + 0.5) / (df + 0.5) + 1)
        const norm = 1 - B + B * (docLength / this.avgDocLength)
        score += idf * ((freq * (K1 + 1)) / (freq + K1 * norm))
      }
      if (score > 0) scores.push({ id: docId, score })
    }

    return scores
      .sort((a, b) => b.score - a.score)
      .slice(0, topK)
      .map((s, i) => ({ documentId: s.id, score: s.score, rank: i + 1 }))
  }
}

export function createBM25Index(docs: BM25Document[]): BM25Index {
  return new BM25Index(docs)
}
