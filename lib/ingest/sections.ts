import type { SourcePage } from '@/lib/ai/structure'

// Sections for a slide deck, derived rather than detected.
//
// A PDF needs a model to find where its sections begin, because a PDF is a river of text
// with no marked boundaries. A slide deck already HAS its boundaries: one slide is one
// unit, authored that way. Asking Gemini to guess them would be paying a model to
// rediscover arithmetic we can do exactly — and it would introduce the one failure the
// PDF path has to defend against, a model returning offsets that do not line up with the
// text, for a document where the offsets are already known.
//
// So the PPTX path makes ZERO generation calls during ingestion. That is also why a PPTX
// costs roughly a tenth of a cent to ingest against a PDF's eleven.

export interface DerivedSection {
  heading: string
  pageStart: number
  pageEnd: number
  startOffset: number
  endOffset: number
}

/** The slide's first non-empty line, which is where its title sits in every ordinary
 *  layout. Falls back to the slide number so a heading is never blank. */
export function slideHeading(text: string, pageNumber: number): string {
  const first = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!first) return `Slide ${pageNumber}`
  return first.length > 200 ? `${first.slice(0, 197)}...` : first
}

/**
 * One section per slide, spanning exactly that slide's text in the joined document.
 *
 * Offsets come straight from the page offsets the pipeline already computed, so
 * `fullText.slice(startOffset, endOffset)` is that slide's text by construction — the
 * invariant lib/ai/chunk.ts depends on holds without any clamping.
 *
 * Slides that produced no text are skipped: a zero-width section would chunk to nothing
 * and leave an empty row pointing at a slide with nothing on it.
 */
export function deriveSlideSections(pages: SourcePage[]): DerivedSection[] {
  return pages
    .filter((p) => p.text.trim().length > 0)
    .map((p) => ({
      heading: slideHeading(p.text, p.pageNumber),
      pageStart: p.pageNumber,
      pageEnd: p.pageNumber,
      startOffset: p.offset,
      endOffset: p.offset + p.text.length,
    }))
}
