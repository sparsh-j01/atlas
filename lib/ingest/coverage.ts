import type { UnreadReason } from './pptx'

// What the uploader is told about the parts of their document that produced no text.
//
// This exists because the alternative is the failure class documented in
// lib/ai/structure.ts: content that is silently absent from generation, with nothing in
// the UI to say so. A teacher whose deck is half scanned screenshots would otherwise see
// a successful ingest and questions drawn from the other half, and have no way to know.
//
// The rule is: a slide that contributes nothing is always REPORTED, never fatal.

/** A page carries too little text to be worth generating from, and has an image that might
 *  contain the text instead. Both halves are required — a blank slide with no image has
 *  nothing for OCR to read, so sending it to OCR would only cost time. */
export const TEXT_POOR_MAX_CHARS = 120

export function isTextPoor(text: string, imageCount: number): boolean {
  return text.trim().length < TEXT_POOR_MAX_CHARS && imageCount > 0
}

export interface UnreadPage {
  pageNumber: number
  reason: UnreadReason
}

/** One short sentence per reason, in the product's voice. `image_only` is the case where
 *  OCR ran (or was skipped) and still found nothing worth keeping. */
const REASON_TEXT: Record<UnreadReason, string> = {
  parse_error: 'could not be read',
  empty: 'has no text on it',
  image_only: 'is an image with no text we could recognise',
}

export interface CoverageReport {
  totalPages: number
  readPages: number
  unread: UnreadPage[]
  /** Ready to render. Empty when everything was read. */
  message: string
}

export function buildCoverageReport(totalPages: number, unread: UnreadPage[]): CoverageReport {
  const sorted = [...unread].sort((a, b) => a.pageNumber - b.pageNumber)
  return {
    totalPages,
    readPages: totalPages - sorted.length,
    unread: sorted,
    message: describeCoverage(sorted),
  }
}

function describeCoverage(unread: UnreadPage[]): string {
  if (unread.length === 0) return ''
  const detail = unread.map((u) => `slide ${u.pageNumber} — ${REASON_TEXT[u.reason]}`).join(' · ')
  const count = unread.length === 1 ? '1 slide' : `${unread.length} slides`
  return `${count} produced no text: ${detail}`
}
