// The retrieval corpus for the RAG evaluation (M7 phase 20, Golden Dataset v1).
//
// WHY THIS REPLACED THE OLD CORPUS. The previous retrieval document was 1,052 chars and
// produced THREE chunks against a 500-token cap. Measured consequences: BM25 alone scored
// 9/9 gold chunks at rank 1 (MRR 1.000, recall@5 = recall@10 = 1.000), so the hybrid
// architecture had exactly zero measurable headroom over plain keyword search; and a
// random-permutation retriever also scored recall@5 = recall@10 = 1.000, because
// retrieve(query, 10) over 3 chunks returns everything. The benchmark could not fail.
//
// Recall@K only means something when the corpus is much larger than K. These documents are
// sized so that it is: 60-100 chunks each, against a reported K of at most 10.
//
// WHY THREE DOCUMENTS, NOT ONE BIG ONE. Retrieval in Atlas is scoped to a single document
// (`createRetriever` loads chunks WHERE documentId = ?), so three documents are three
// separate retrieval universes rather than one larger one — per-document chunk count is
// what decides whether ranking can discriminate. Three exist for a different reason:
// a single textbook chapter is homogeneous, and homogeneous prose makes the vector and
// BM25 rankings CORRELATED. Fusing correlated rankers cannot help, so a one-chapter corpus
// can be undiscriminating at any size. The three registers are deliberately far apart:
//
//   social psychology  — experimental social science, named studies and researchers
//   the big bang       — quantitative cosmology, numerals, units, named observations
//   patent enforcement — legal prose, case names, statute citations, doctrine
//
// WHY THE TEXT IS PINNED RATHER THAN RE-FETCHED. `detectSections` is a live model call, so
// re-ingesting identical bytes yields different section boundaries, therefore different
// chunks, therefore different recall. Gold evidence is recorded as character offsets into
// exactly this text. Re-fetching would silently invalidate every offset.
//
// WHAT WAS REMOVED, AND WHY IT MATTERS. `droppedSections` on each document records what was
// excluded. Two exclusions are load-bearing rather than cosmetic:
//   - "Review Questions" / "Assessment Questions" are the textbook's OWN quiz questions.
//     Left in, the generation eval would let the model COPY questions out of the source
//     instead of writing them, and score well for it.
//   - "Key Terms" is a glossary. Left in, every keyword-heavy query would have a single
//     obvious home and document frequency would stop meaning anything.
// Figure captions, credit lines and the repeated "Learning Objectives" scaffolding are also
// stripped; the last of those is identical across every section and would otherwise create
// near-duplicate chunks that say nothing.
//
// LICENSING. All three books are Creative Commons Attribution 4.0 (plain CC BY, no
// NonCommercial or ShareAlike clause) and are live rather than retired in the OpenStax
// release manifest. That combination is not the norm: of 129 OpenStax books, 46 are CC BY
// and 72 are CC BY-NC-SA, and 11 of the CC BY ones are retired. Any replacement document
// must be re-checked on both counts — `book.license` is asserted in the corpus tests.

import raw from './openstax-corpus.json'

export interface CorpusBook {
  slug: string
  title: string
  /** Book UUID in the OpenStax archive, for re-fetching. */
  cnxId: string
  /** Book content version this text came from. */
  version: string
  license: string
  licenseUrl: string
}

export interface CorpusDocument {
  id: string
  filename: string
  chapter: string
  /** Prose style, recorded because register diversity is the point of having three. */
  register: string
  book: CorpusBook
  attribution: string
  /** OpenStax archive build these pages were fetched from. */
  archiveBuild: string
  sectionTitles: string[]
  /** Page UUIDs, in order, so a fetch can be reproduced exactly. */
  pageIds: string[]
  /** Sections deliberately excluded, with the reason where it is not obvious. */
  droppedSections: string[]
  chars: number
  /** sha256 of `fullTextOf(doc)` — a re-fetch that does not match this is not this corpus. */
  contentSha256: string
  /** Section texts. Joined with '\n\n' to mirror how lib/ingestion.ts builds full text. */
  pages: string[]
}

interface CorpusFile {
  version: string
  builtAt: string
  archiveBuild: string
  note: string
  documents: CorpusDocument[]
}

const corpus = raw as CorpusFile

export const CORPUS_VERSION = corpus.version
export const CORPUS_BUILT_AT = corpus.builtAt
export const ARCHIVE_BUILD = corpus.archiveBuild
export const CORPUS_DOCUMENTS: CorpusDocument[] = corpus.documents

/** Required license for every corpus document. Asserted in the corpus tests: CC BY-NC-SA
 *  would restrict redistribution of a public portfolio repo, and most OpenStax books carry
 *  it, so this is a live hazard rather than a formality. */
export const REQUIRED_LICENSE = 'CC BY 4.0'

export function getCorpusDocument(id: string): CorpusDocument | undefined {
  return CORPUS_DOCUMENTS.find((d) => d.id === id)
}

/** Joined document text. Gold evidence offsets are indices into exactly this string. */
export function corpusFullText(doc: CorpusDocument): string {
  return doc.pages.join('\n\n')
}
