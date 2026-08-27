// Reciprocal rank fusion (M7 phase 8): merge the vector and BM25 rankings into one.
//
// RRF combines by POSITION, not by score, which is the whole point — a cosine similarity
// and a BM25 score share no scale, so anything that adds or averages them is comparing
// units that don't exist. Each list contributes 1/(k + rank).
//
// k=60 is the value from the original Cormack et al. paper and the de facto default. It
// flattens the difference between the top few ranks so a chunk that both retrievers like
// beats one that only the stronger retriever loves.
//
// Consequence worth remembering: the fused score has no interpretable scale. Its maximum
// is 2/(k+1) ≈ 0.033 for a chunk ranked first by both. Thresholding it against anything
// that looks like a similarity rejects everything — see RELEVANCE_FLOOR in retrieve.ts.
export const RRF_K = 60
const K = RRF_K

export interface FusedResult {
  chunkId: string
  score: number
  rank: number
}

export function rrfFromChunks(
  vectorResults: { chunkId: string; score: number }[],
  keywordResults: { chunkId: string; score: number }[],
  topK: number,
): FusedResult[] {
  const fused = new Map<string, number>()
  for (const list of [vectorResults, keywordResults]) {
    list.forEach((item, i) => {
      fused.set(item.chunkId, (fused.get(item.chunkId) ?? 0) + 1 / (K + i + 1))
    })
  }

  return [...fused]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK)
    .map(([chunkId, score], i) => ({ chunkId, score, rank: i + 1 }))
}
