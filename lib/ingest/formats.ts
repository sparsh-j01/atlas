import { extractPptx } from './pptx'
import { ZipLimitError } from './zip'

// One table per accepted upload format, and the upload route's ladder reads from it.
//
// Before this, "we accept PDFs" was spread across five places that each had to be found
// and edited to accept a sixth: a hard-coded `file.type !== 'application/pdf'`, a PDF_MAGIC
// constant, a storage bucket's allowed_mime_types, an `accept` attribute in the uploader,
// and a dead UPLOAD_LIMITS.allowedMimeTypes nothing ever read. Adding a format meant
// finding all of them; missing one meant a file that passed every app check and was then
// rejected by storage.
//
// The ladder is unchanged and still cheapest-first — the registry only supplies what each
// rung compares against:
//
//   Content-Length ─> declared type ─> read bytes ─> size ─> magic bytes ─> probe ─> pages

export type FormatId = 'pdf' | 'pptx'

export type ProbeResult = { ok: true; pageCount: number } | { ok: false; error: string }

export interface FormatSpec {
  id: FormatId
  /** The single MIME type accepted for this format, and what the object is stored as. */
  mimeType: string
  /** Storage object suffix. Also what the bucket's allowed_mime_types must permit. */
  extension: string
  /** Leading bytes every file of this format begins with. */
  magic: readonly number[]
  /** User-facing noun, for error copy. */
  label: string
  /** What one page/slide is called when talking to the uploader. */
  unit: string
  /**
   * Parse far enough to know the file is usable, and no further.
   *
   * This is where a file that is merely *shaped* right gets rejected: every OOXML document
   * begins with the same four zip bytes, so a .docx renamed to .pptx passes the magic
   * check and fails here, on having no slides.
   */
  probe(buffer: Uint8Array, maxPages: number): Promise<ProbeResult>
}

export const PDF_FORMAT: FormatSpec = {
  id: 'pdf',
  mimeType: 'application/pdf',
  extension: 'pdf',
  magic: [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
  label: 'PDF',
  unit: 'page',
  async probe(buffer, maxPages) {
    try {
      const { getDocumentProxy } = await import('unpdf')
      const doc = await getDocumentProxy(new Uint8Array(buffer))
      const pageCount = doc.numPages

      if (pageCount === 0) return { ok: false, error: 'That PDF has no pages.' }
      if (pageCount > maxPages) return { ok: false, error: `Too many pages. Maximum ${maxPages}.` }

      // Sample rather than scan: a text PDF shows a text layer within its first few pages,
      // and parsing 200 pages here would duplicate the extraction stage's work inside the
      // upload request.
      for (let i = 1; i <= Math.min(pageCount, 5); i++) {
        const content = await (await doc.getPage(i)).getTextContent()
        const hasText = content.items.some(
          (item) => 'str' in item && typeof item.str === 'string' && item.str.trim().length > 0,
        )
        if (hasText) return { ok: true, pageCount }
      }
      return {
        ok: false,
        error: 'That PDF has no selectable text. Scanned or image-only files are not supported yet.',
      }
    } catch (error) {
      // Covers encrypted files, truncated files and malformed xref tables alike: the parser
      // refused it, so we refuse it, without leaking parser internals to the caller.
      const message = error instanceof Error ? error.message : ''
      if (/password|encrypt/i.test(message))
        return { ok: false, error: 'That PDF is password-protected. Remove the password and try again.' }
      return { ok: false, error: 'That PDF could not be read. It may be corrupted.' }
    }
  },
}

export const PPTX_FORMAT: FormatSpec = {
  id: 'pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  extension: 'pptx',
  magic: [0x50, 0x4b, 0x03, 0x04], // "PK\x03\x04" — every zip, so the probe does the real work
  label: 'PowerPoint file',
  unit: 'slide',
  async probe(buffer, maxPages) {
    try {
      // Full extraction, not a sample: it is the only way to know how many slides there
      // are and whether any of them carry text, and it is all local work — no model call,
      // no network. Slide XML for a 200-slide deck parses in well under the request budget.
      const { pages } = extractPptx(buffer)
      if (pages.length > maxPages) return { ok: false, error: `Too many slides. Maximum ${maxPages}.` }

      // A deck of nothing but scanned screenshots is accepted here, unlike the equivalent
      // PDF: OCR runs later and may well recover the text. What is rejected is a deck with
      // no text AND no images, which nothing downstream can rescue.
      const hasText = pages.some((p) => p.text.trim().length > 0)
      const hasImages = pages.some((p) => p.unreadReason === 'image_only')
      if (!hasText && !hasImages)
        return { ok: false, error: 'That presentation has no text and no images on any slide.' }

      return { ok: true, pageCount: pages.length }
    } catch (error) {
      if (error instanceof ZipLimitError)
        return { ok: false, error: 'That presentation is too large once unpacked.' }
      const message = error instanceof Error ? error.message : ''
      if (/no slides/i.test(message))
        return { ok: false, error: 'That file is not a PowerPoint presentation.' }
      return { ok: false, error: 'That presentation could not be read. It may be corrupted.' }
    }
  },
}

export const FORMATS: readonly FormatSpec[] = [PDF_FORMAT, PPTX_FORMAT]

export const ACCEPTED_MIME_TYPES: readonly string[] = FORMATS.map((f) => f.mimeType)

/** The `accept` attribute for a file input, and the storage bucket's allowlist. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_MIME_TYPES.join(',')

export function formatForMime(mimeType: string): FormatSpec | undefined {
  return FORMATS.find((f) => f.mimeType === mimeType)
}

export function formatForId(id: string): FormatSpec | undefined {
  return FORMATS.find((f) => f.id === id)
}

/** Content sniffing, because a declared Content-Type is just a string the caller chose. */
export function matchesMagic(format: FormatSpec, buffer: Uint8Array): boolean {
  if (buffer.length < format.magic.length) return false
  return format.magic.every((byte, i) => buffer[i] === byte)
}

/** "PDF or PowerPoint file", for a rejection message that names what IS accepted. */
export function acceptedLabels(): string {
  const labels = FORMATS.map((f) => f.label)
  return labels.length < 2 ? labels.join('') : `${labels.slice(0, -1).join(', ')} or ${labels.at(-1)}`
}
