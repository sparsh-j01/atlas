import { attr, decodeEntities, scanXml } from './xml'
import { readZipEntries, type ZipEntry } from './zip'

// PPTX extraction: a .pptx is an OOXML zip, and one slide becomes one document_pages row.
//
// That mapping is the whole design. `document_pages` already holds "an ordered, numbered
// unit of source text with an immutable body", which is exactly what a slide is — so PPTX
// rides the existing chunk -> embed -> retrieve path with those modules untouched, and no
// parallel document model has to be kept in sync with them.
//
// What a slide contributes, in document order:
//   text shapes  -> one line per paragraph
//   tables       -> one line per row, cells joined by " | "
//   speaker notes-> appended after the body, behind a label
//   pictures     -> no text; recorded as an asset row for the OCR stage to read
//
// Slides that cannot be parsed are SKIPPED and RECORDED, never dropped silently and never
// fatal to the deck: failing a 200-slide upload over one corrupt slide is hostile, and
// dropping it quietly is the failure class documented in lib/ai/structure.ts. The reason
// travels to the UI as a coverage report.

/** Body and notes are separated by this, so a citation landing in the notes is legible as
 *  notes rather than as something that was on screen. */
export const NOTES_LABEL = 'Speaker notes:'

const CELL_SEPARATOR = ' | '

export type UnreadReason = 'parse_error' | 'empty' | 'image_only'

export interface PptxPage {
  pageNumber: number
  text: string
  /** Set when the slide contributed no usable text. Surfaced to the uploader. */
  unreadReason?: UnreadReason
}

export interface PptxAsset {
  pageNumber: number
  /** Position within the slide, so two images on one slide stay distinguishable. */
  assetIndex: number
  /** Path INSIDE the stored .pptx, e.g. "ppt/media/image3.png".
   *  The bytes are not copied out — see docs on readAssetBytes(). */
  entryPath: string
  mimeType: string
}

export interface PptxDocument {
  pages: PptxPage[]
  assets: PptxAsset[]
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  emf: 'image/x-emf',
  wmf: 'image/x-wmf',
}

function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return MEDIA_TYPES[ext] ?? 'application/octet-stream'
}

/** slide2.xml must sort before slide10.xml. Lexicographic order puts them the other way
 *  round, which silently renumbers every slide in a deck of ten or more. */
function slideNumber(path: string): number {
  const m = path.match(/slide(\d+)\.xml$/i)
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER
}

/** Resolve a relationship Target against the part that declared it.
 *  "../media/image1.png" declared in ppt/slides/ resolves to ppt/media/image1.png. */
function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const base = fromPart.slice(0, fromPart.lastIndexOf('/'))
  const segments = base.split('/')
  for (const part of target.split('/')) {
    if (part === '.' || part === '') continue
    if (part === '..') segments.pop()
    else segments.push(part)
  }
  return segments.join('/')
}

/** Parse a _rels sidecar into { rId -> resolved part path }. */
function readRelationships(xml: string, fromPart: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const token of scanXml(xml)) {
    if ('name' in token && token.name === 'Relationship' && token.kind !== 'close') {
      const id = attr(token.raw, 'Id')
      const target = attr(token.raw, 'Target')
      // External targets are URLs to somewhere else entirely; there are no bytes to read.
      if (id && target && attr(token.raw, 'TargetMode') !== 'External')
        map.set(id, resolveTarget(fromPart, target))
    }
  }
  return map
}

interface SlideContent {
  text: string
  imageRefs: string[]
}

/**
 * Pull text and image references out of one slide part, in document order.
 *
 * Reading order is the order shapes appear in the XML, which is PowerPoint's z-order.
 * For ordinary slides that matches how the deck reads; for a heavily hand-arranged slide
 * it may not.
 * ponytail: no geometric sort. Upgrade path if it matters: sort shapes by <a:off> y then x.
 */
export function extractSlideContent(xml: string): SlideContent {
  const lines: string[] = []
  const imageRefs: string[] = []

  // Text accumulates per paragraph; paragraphs become lines, except inside a table cell
  // where they become the cell's contents.
  let paragraph = ''
  let cell: string[] | null = null
  let row: string[] | null = null

  const flushParagraph = () => {
    const value = paragraph.trim()
    paragraph = ''
    if (!value) return
    if (cell) cell.push(value)
    else lines.push(value)
  }

  let inText = false
  for (const token of scanXml(xml)) {
    if (token.kind === 'text') {
      if (inText) paragraph += token.value
      continue
    }
    switch (token.name) {
      case 'a:t':
        if (token.kind === 'open') inText = true
        else if (token.kind === 'close') inText = false
        break
      // A soft line break inside a run is a space, not a paragraph boundary — joining
      // across it would weld two words together.
      case 'a:br':
        if (token.kind !== 'close') paragraph += ' '
        break
      case 'a:p':
        if (token.kind === 'close') flushParagraph()
        break
      case 'a:tr':
        if (token.kind === 'open') row = []
        else if (token.kind === 'close') {
          if (row && row.length > 0) lines.push(row.join(CELL_SEPARATOR))
          row = null
        }
        break
      case 'a:tc':
        if (token.kind === 'open') cell = []
        else if (token.kind === 'close') {
          // Flush anything still buffered before the cell closes, then commit the cell —
          // an empty cell still holds a column position, so it is pushed as "".
          flushParagraph()
          if (row) row.push((cell ?? []).join(' '))
          cell = null
        }
        break
      case 'a:blip': {
        const id = attr(token.raw, 'r:embed') ?? attr(token.raw, 'r:link')
        if (id) imageRefs.push(id)
        break
      }
    }
  }
  flushParagraph()

  return { text: lines.join('\n'), imageRefs }
}

/** Slide markup that never reached a spTree is not a slide, whatever else it contains. */
function looksLikeSlide(xml: string): boolean {
  return xml.includes('spTree')
}

const decoder = new TextDecoder('utf-8', { fatal: false })

/**
 * Read a .pptx into pages and asset metadata.
 *
 * Throws only when the archive itself is unusable (bad zip, no slides, or a decompression
 * limit tripped). A slide-level problem never throws — it lands as an unreadReason.
 */
export function extractPptx(data: Uint8Array): PptxDocument {
  const entries = readZipEntries(data)
  const byPath = new Map<string, ZipEntry>(entries.map((e) => [e.path, e]))

  const slidePaths = entries
    .map((e) => e.path)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/i.test(p))
    .sort((a, b) => slideNumber(a) - slideNumber(b))

  if (slidePaths.length === 0) throw new Error('That file contains no slides.')

  const pages: PptxPage[] = []
  const assets: PptxAsset[] = []

  slidePaths.forEach((slidePath, index) => {
    // Dense, 1-based, and independent of the file's own numbering: slide 12 is the twelfth
    // slide in the deck even if the archive names it slide13.xml.
    const pageNumber = index + 1
    try {
      const xml = decoder.decode(byPath.get(slidePath)!.bytes)
      if (!looksLikeSlide(xml)) {
        pages.push({ pageNumber, text: '', unreadReason: 'parse_error' })
        return
      }

      const { text, imageRefs } = extractSlideContent(xml)
      const rels = readRelsFor(byPath, slidePath)

      imageRefs.forEach((rId) => {
        const target = rels.get(rId)
        // Only media that is actually in the archive, and only under the prefix the zip
        // reader was allowed to open. A relationship pointing anywhere else is ignored.
        if (!target || !target.startsWith('ppt/media/') || !byPath.has(target)) return
        assets.push({
          pageNumber,
          assetIndex: assets.filter((a) => a.pageNumber === pageNumber).length,
          entryPath: target,
          mimeType: mimeOf(target),
        })
      })

      const notes = readNotesFor(byPath, slidePath, rels)
      const body = notes ? [text, `${NOTES_LABEL}\n${notes}`].filter(Boolean).join('\n\n') : text
      const hasImage = assets.some((a) => a.pageNumber === pageNumber)

      pages.push({
        pageNumber,
        text: body,
        unreadReason: body.trim() ? undefined : hasImage ? 'image_only' : 'empty',
      })
    } catch {
      // Whatever went wrong in one slide, the other 199 still ingest.
      pages.push({ pageNumber, text: '', unreadReason: 'parse_error' })
    }
  })

  return { pages, assets }
}

function readRelsFor(byPath: Map<string, ZipEntry>, slidePath: string): Map<string, string> {
  const name = slidePath.slice(slidePath.lastIndexOf('/') + 1)
  const relsPath = `ppt/slides/_rels/${name}.rels`
  const entry = byPath.get(relsPath)
  if (!entry) return new Map()
  try {
    return readRelationships(decoder.decode(entry.bytes), slidePath)
  } catch {
    return new Map()
  }
}

/** Notes are located through the slide's own relationships, not by filename arithmetic:
 *  notesSlide3.xml belongs to whichever slide points at it, and a deck where only some
 *  slides carry notes has no matching numbering at all. */
function readNotesFor(
  byPath: Map<string, ZipEntry>,
  slidePath: string,
  rels: Map<string, string>,
): string {
  const target = [...rels.values()].find((t) => t.startsWith('ppt/notesSlides/'))
  const entry = target ? byPath.get(target) : undefined
  if (!entry) return ''
  try {
    const { text } = extractSlideContent(decoder.decode(entry.bytes))
    // The notes part repeats the slide's own text in a placeholder shape. Drop the lines
    // that are pure slide numbers, which is what that placeholder usually renders as.
    return text
      .split('\n')
      .filter((line) => !/^\d+$/.test(line.trim()))
      .join('\n')
      .trim()
  } catch {
    return ''
  }
}

export { decodeEntities }
