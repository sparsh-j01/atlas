// Gold evidence and how a retrieved chunk is judged against it.
//
// THE GRADING IDENTITY IS AN INTERVAL OVERLAP, NOT A SUBSTRING MATCH.
//
// The previous grader asked `normalize(chunk.text).includes(expectedSpan)`. That reads as
// the obvious thing to do and is wrong in five ways that all show up on a real corpus:
//
//   evidence straddles a chunk boundary  -> in NO chunk's text, so it scores 0 for EVERY
//                                           retriever, permanently, and presents as a
//                                           retrieval failure that is really a dataset bug
//   the same sentence appears twice      -> grades whichever copy it hits first, silently
//   chunk overlap is switched on         -> one passage lands in two chunks, double counted
//   extraction normalises differently    -> a span stops matching its own source text
//   a different passage also answers it  -> counted as a miss
//
// Chunks already carry exact source coordinates (`lib/ai/chunk.ts` guarantees
// `fullText.slice(charStart, charEnd) === text` by construction, because a chunk IS a
// range and its text is produced by slicing). So grading by coordinate overlap needs no
// new infrastructure and survives all five cases.
//
// Text is still recorded next to every interval, but only as an INTEGRITY ASSERTION:
// `fullText.slice(charStart, charEnd)` must equal it, so a mistyped offset fails loudly at
// test time instead of quietly grading nothing.

/** A range of the SOURCE document, plus the text it must equal. Half-open: [start, end). */
export interface GoldInterval {
  charStart: number
  charEnd: number
  /** Integrity only. Never used to decide a hit. */
  text: string
}

/** The retrieval-side view of a chunk: where it came from, not just what it says. */
export interface RetrievedChunk {
  chunkId: string
  charStart: number
  charEnd: number
  text: string
  /** Cosine similarity, or null for an arm that produces no similarity (BM25-only). */
  similarity: number | null
}

/** Half-open overlap. Touching ranges do NOT overlap: a chunk ending exactly where the
 *  evidence begins contains none of it.
 *
 *  Empty ranges overlap nothing. Without that guard `[5,5)` "overlaps" `[0,10)` under the
 *  usual two-comparison form, which would let a degenerate gold interval count as a hit
 *  everywhere it was nested and inflate `chunksSpanned`. */
export function overlaps(
  a: { charStart: number; charEnd: number },
  b: { charStart: number; charEnd: number },
): boolean {
  if (a.charEnd <= a.charStart || b.charEnd <= b.charStart) return false
  return a.charStart < b.charEnd && b.charStart < a.charEnd
}

/**
 * 1-based rank of the first retrieved chunk overlapping ANY required interval, 0 for a miss.
 *
 * This is the direct replacement for `firstHitRank`. A query with several accepted
 * intervals (alternate passages that equally support the answer) is satisfied by any one.
 */
export function firstOverlapRank(retrieved: RetrievedChunk[], evidence: GoldInterval[]): number {
  if (evidence.length === 0) return 0
  for (const [i, chunk] of retrieved.entries()) {
    if (evidence.some((ev) => overlaps(chunk, ev))) return i + 1
  }
  return 0
}

/**
 * Whether EVERY required interval was retrieved.
 *
 * The gap between this and `firstOverlapRank` is the real measure of the contextual and
 * boundary query categories: evidence split across two chunks is "found" the moment one of
 * them arrives, but the model only has enough to answer when both do. Substring grading
 * cannot express the difference at all.
 */
export function coversAllEvidence(retrieved: RetrievedChunk[], evidence: GoldInterval[]): boolean {
  if (evidence.length === 0) return false
  return evidence.every((ev) => retrieved.some((chunk) => overlaps(chunk, ev)))
}

/** How many of a document's chunks a gold interval touches. 2 or more means the evidence
 *  straddles a chunk boundary, which is the case substring grading could never score. */
export function chunksSpanned(
  chunks: { charStart: number; charEnd: number }[],
  interval: GoldInterval,
): number {
  return chunks.filter((c) => overlaps(c, interval)).length
}

/**
 * Locate a span in the source and return it as an interval.
 *
 * Deliberately strict: a span that appears zero times or MORE THAN ONCE is rejected rather
 * than resolved to its first occurrence. Ambiguity here is exactly the "same sentence twice"
 * failure that made substring grading unreliable, and silently picking one copy would
 * reintroduce it at authoring time instead of at grading time.
 */
export function spanToInterval(
  fullText: string,
  span: string,
): { ok: true; value: GoldInterval } | { ok: false; error: string } {
  if (span.length === 0) return { ok: false, error: 'empty span' }
  const first = fullText.indexOf(span)
  if (first < 0) return { ok: false, error: `span not found: ${JSON.stringify(span.slice(0, 60))}` }
  const second = fullText.indexOf(span, first + 1)
  if (second >= 0)
    return {
      ok: false,
      error: `span is ambiguous, found at ${first} and ${second}: ${JSON.stringify(span.slice(0, 60))}`,
    }
  return { ok: true, value: { charStart: first, charEnd: first + span.length, text: span } }
}

/** Integrity check: every interval must still quote the source exactly, and lie in bounds. */
export function verifyInterval(
  fullText: string,
  interval: GoldInterval,
): { ok: true } | { ok: false; error: string } {
  if (interval.charStart < 0 || interval.charEnd > fullText.length)
    return { ok: false, error: `out of bounds [${interval.charStart}, ${interval.charEnd})` }
  if (interval.charEnd <= interval.charStart)
    return { ok: false, error: `empty or inverted [${interval.charStart}, ${interval.charEnd})` }
  const actual = fullText.slice(interval.charStart, interval.charEnd)
  if (actual !== interval.text)
    return {
      ok: false,
      error: `text mismatch: recorded ${JSON.stringify(interval.text.slice(0, 40))} but source has ${JSON.stringify(actual.slice(0, 40))}`,
    }
  return { ok: true }
}
