import { sha256 } from '@/lib/crypto'
import type { StructureSection } from './structure'

// Structure-aware chunking (M7 phase 4). Sections come from structure detection; this
// module cuts each section into retrieval-sized pieces and records exactly where each
// piece came from.
//
// THE INVARIANT, and the whole reason this file is shaped the way it is:
//
//     fullText.slice(chunk.charStart, chunk.charEnd) === chunk.text
//
// A chunk is a contiguous [charStart, charEnd) RANGE of the source, and its text is
// produced by slicing — never by concatenating pieces and computing an offset afterwards.
// Wrong offsets are therefore unrepresentable rather than merely untested.
//
// The previous version accumulated strings and recovered positions with
// `text.indexOf(paragraph)`, which returns the FIRST occurrence rather than this one. On a
// document with a repeated paragraph it emitted chunks whose recorded span pointed at a
// different copy, out-of-order spans, and 15% of the section cited by nothing. Provenance
// is the entire point of the RAG path — a citation that lands on the wrong passage is
// worse than no citation, because the teacher trusts it. See docs/failure-patterns.md.
//
//   section text
//        │
//        ├─ segments()  paragraphs as ABSOLUTE spans (never strings)
//        │
//        ├─ pack()      greedily merge adjacent spans up to maxTokens
//        │                ├─ span alone > maxTokens ─> re-segment by sentence
//        │                └─ sentence alone > maxTokens ─> hard split on char count
//        │
//        └─ slice()     text = fullText.slice(start, end)   <- invariant holds by construction

export interface ChunkResult {
  sectionId: string
  pageStart: number
  pageEnd: number
  charStart: number
  charEnd: number
  text: string
  tokenCount: number
  contentHash: string
}

export interface ChunkOptions {
  /** Upper bound per chunk. A boundary, not a target — structure wins where it can. */
  maxTokens?: number
  /** Tokens of the previous chunk repeated at the start of the next. The plan calls for
   *  benchmarking this rather than assuming 10%, so it is a real knob with a real
   *  implementation; 0 (no overlap) is the default because structure-aware cuts already
   *  land on paragraph boundaries. */
  overlapTokens?: number
}

export const MAX_TOKENS = 500
const CHARS_PER_TOKEN = 4

/** Rough token count. Good enough for a boundary check; exact counts would need the
 *  provider's tokenizer, and being 15% off just moves a paragraph between chunks. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

type Span = { start: number; end: number }

/**
 * Split `[from, to)` of `source` on `separator`, returning ABSOLUTE spans with surrounding
 * whitespace trimmed off each piece. Returns spans rather than strings so no caller can
 * later have to guess where a string came from.
 */
function segments(source: string, from: number, to: number, separator: RegExp): Span[] {
  const spans: Span[] = []
  const re = new RegExp(separator.source, separator.flags.includes('g') ? separator.flags : separator.flags + 'g')
  re.lastIndex = 0
  let cursor = from
  const region = source.slice(from, to)
  let m: RegExpExecArray | null
  while ((m = re.exec(region)) !== null) {
    push(spans, source, cursor, from + m.index)
    cursor = from + m.index + m[0].length
    if (m[0].length === 0) re.lastIndex++ // zero-width match guard
  }
  push(spans, source, cursor, to)
  return spans
}

/** Trim whitespace off both ends of [start, end) and keep it if anything survives. */
function push(spans: Span[], source: string, start: number, end: number): void {
  let s = start
  let e = end
  while (s < e && /\s/.test(source[s])) s++
  while (e > s && /\s/.test(source[e - 1])) e--
  if (e > s) spans.push({ start: s, end: e })
}

const PARAGRAPH = /\n\s*\n/
const SENTENCE = /(?<=[.!?])\s+/

/** Fixed-width fallback for a single sentence that still busts the cap (tables, formulas,
 *  a page of prose with no terminator). Cuts on character count — crude, but it is the
 *  only boundary left, and it keeps spans contiguous. */
function hardSplit(span: Span, maxChars: number): Span[] {
  const out: Span[] = []
  for (let s = span.start; s < span.end; s += maxChars) {
    out.push({ start: s, end: Math.min(s + maxChars, span.end) })
  }
  return out
}

/** Paragraph spans, with any oversized paragraph replaced by its sentence spans. */
function leafSpans(source: string, section: Span, maxTokens: number): Span[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  const out: Span[] = []
  for (const para of segments(source, section.start, section.end, PARAGRAPH)) {
    if (para.end - para.start <= maxChars) {
      out.push(para)
      continue
    }
    for (const sentence of segments(source, para.start, para.end, SENTENCE)) {
      if (sentence.end - sentence.start <= maxChars) out.push(sentence)
      else out.push(...hardSplit(sentence, maxChars))
    }
  }
  return out
}

/**
 * Greedily merge adjacent leaf spans into chunk ranges no larger than `maxTokens`.
 * Merging keeps the separator whitespace inside the range, which is what makes the
 * result a contiguous slice of the source rather than a reassembly of it.
 */
function pack(spans: Span[], maxTokens: number, overlapTokens: number): Span[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN
  // Cap overlap below half a chunk so the carried tail can never swallow the whole
  // budget and stall progress.
  const overlapChars = Math.min(overlapTokens, Math.floor(maxTokens / 2)) * CHARS_PER_TOKEN
  const chunks: Span[] = []
  let cur: Span | null = null

  for (const span of spans) {
    if (cur === null) {
      cur = { ...span }
      continue
    }
    if (span.end - cur.start <= maxChars) {
      cur.end = span.end
      continue
    }
    const flushed: Span = cur
    chunks.push(flushed)
    // Start the next chunk `overlapChars` back into the one just flushed, never before
    // its start (that would duplicate text from a chunk two back).
    const overlapStart =
      overlapChars > 0 ? Math.max(flushed.start, flushed.end - overlapChars) : span.start
    cur = { start: Math.min(overlapStart, span.start), end: span.end }
  }
  if (cur !== null) chunks.push(cur)
  return chunks
}

/** A persisted section: the detected boundary plus the row id chunks will point at. */
export type IdentifiedSection = StructureSection & { id: string }

export async function chunkDocument(
  fullText: string,
  // Sections carry their own id rather than being looked up by heading. A heading is not
  // unique — a deck with two "Introduction" sections collapsed into one Map entry, and
  // every chunk of the second section was filed under the first section's id.
  sections: IdentifiedSection[],
  options: ChunkOptions = {},
): Promise<ChunkResult[]> {
  const maxTokens = options.maxTokens ?? MAX_TOKENS
  const overlapTokens = options.overlapTokens ?? 0
  const results: ChunkResult[] = []

  for (const section of sections) {
    const sectionId = section.id

    // Clamp to the real text. Offsets come from a model, so treat them as untrusted
    // input: an out-of-range endOffset would otherwise silently produce a short slice.
    const bounds: Span = {
      start: Math.max(0, Math.min(section.startOffset, fullText.length)),
      end: Math.max(0, Math.min(section.endOffset, fullText.length)),
    }
    if (bounds.end <= bounds.start) continue

    for (const span of pack(leafSpans(fullText, bounds, maxTokens), maxTokens, overlapTokens)) {
      const text = fullText.slice(span.start, span.end)
      results.push({
        sectionId,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        charStart: span.start,
        charEnd: span.end,
        text,
        tokenCount: estimateTokens(text),
        contentHash: await sha256(text),
      })
    }
  }

  return results
}
