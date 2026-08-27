import { createHash } from 'node:crypto'
import type { IdentifiedSection } from '@/lib/ai/chunk'
import { CORPUS_VERSION, type CorpusDocument } from './documents/openstax-corpus'

// The pure half of the seeder: id derivation and pinned-section construction.
//
// Split out of `seed.ts` for one reason — `seed.ts` connects to a database and calls
// Gemini the moment it is imported. Keeping these here means the logic that decides WHERE
// every row lands is unit-testable in CI with no database, no key, and no chance of a test
// run reaching a live project by accident.

/** Namespaced, content-derived UUIDs. Deterministic ids are what let the seeder be
 *  idempotent without a bookkeeping table, and what stop the eval from depending on a
 *  document id someone copied out of a psql session by hand. */
const NAMESPACE = 'atlas-eval::'
export function stableUuid(name: string): string {
  const b = Buffer.from(createHash('sha256').update(NAMESPACE + name).digest().subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x50 // version 5
  b[8] = (b[8] & 0x3f) | 0x80 // RFC 4122 variant
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** The one tenant every eval document belongs to. Kept away from real content so the whole
 *  corpus is one `delete from profiles where id = ...` away from being gone. */
export const EVAL_OWNER_ID = stableUuid('owner')

/** Stable per-corpus-document id. Keyed on the corpus VERSION too: a corpus rebuild is a
 *  different document, and silently reusing the id would mix two populations of chunks
 *  under coordinates that no longer agree. */
export function evalDocumentId(corpusId: string): string {
  return stableUuid(`document:${CORPUS_VERSION}:${corpusId}`)
}

/** Chunk id derived from its own CONTENT, so edited text lands as a new row and its stale
 *  embedding cascades away instead of being served against prose it no longer describes. */
export function chunkRowId(documentId: string, index: number, contentHash: string): string {
  return stableUuid(`chunk:${documentId}:${index}:${contentHash}`)
}

/**
 * Sections from the corpus's pinned titles — never from `detectSections`.
 *
 * The offsets MUST match `corpusFullText`, which joins pages with '\n\n'; that is also how
 * `lib/ingestion.ts` reassembles a document (PAGE_SEPARATOR, readPages). Gold intervals
 * index into exactly that string, so the +2 below is load-bearing rather than incidental.
 */
export function buildSections(doc: CorpusDocument): IdentifiedSection[] {
  const documentId = evalDocumentId(doc.id)
  let offset = 0
  return doc.pages.map((page, i) => {
    const section = {
      id: stableUuid(`section:${documentId}:${i}`),
      heading: doc.sectionTitles[i] ?? `Section ${i + 1}`,
      pageStart: i + 1,
      pageEnd: i + 1,
      startOffset: offset,
      endOffset: offset + page.length,
    }
    offset += page.length + 2 // '\n\n'
    return section
  })
}
