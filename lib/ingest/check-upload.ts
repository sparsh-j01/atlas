import { sha256 } from '@/lib/crypto'
import { matchesMagic, type FormatSpec } from './formats'

export type UploadCheck = { ok: true; pageCount: number } | { ok: false; status: number; error: string }

/**
 * The upload ladder, run by /api/documents/{id}/confirm on the bytes AS STORED.
 *
 * Uploads go browser → Storage now (Vercel refuses request bodies over 4.5MB), so the server
 * first sees the file after it is already in the bucket. Every rung the old upload route ran
 * on the request body runs here instead, cheapest first, and a failure deletes the object.
 * The bucket itself already refuses anything over 25MB or not PDF/PPTX by declared type; this
 * is what checks the bytes.
 *
 *   size ─> magic bytes ─> fingerprint ─> probe (pages, zip-bomb limits)
 *
 * The fingerprint is the one the browser claimed when it asked for the upload link, and the
 * storage path was built from it. A file that does not hash to it is refused: otherwise a
 * client could reserve one hash and store different bytes under it, and the dedupe would hand
 * those bytes to the next upload that claims the same hash.
 */
export async function checkUploadedBytes(
  buffer: Buffer,
  format: FormatSpec,
  expectedHash: string,
  limits: { maxFileSize: number; maxPages: number },
): Promise<UploadCheck> {
  const maxMb = limits.maxFileSize / 1024 / 1024
  if (buffer.length === 0) return { ok: false, status: 400, error: 'That file is empty.' }
  if (buffer.length > limits.maxFileSize) return { ok: false, status: 413, error: `File too large. Maximum ${maxMb}MB.` }
  if (!matchesMagic(format, buffer)) return { ok: false, status: 415, error: `That file is not a ${format.label}.` }
  if ((await sha256(buffer)) !== expectedHash)
    return { ok: false, status: 422, error: 'The upload did not arrive intact. Upload the file again.' }
  // Parse far enough to know the file is usable, and no further. For a .pptx this walks the
  // archive under the decompression limits, so a zip bomb is refused here, not mid-pipeline.
  const probe = await format.probe(buffer, limits.maxPages)
  if (!probe.ok) return { ok: false, status: 422, error: probe.error }
  return { ok: true, pageCount: probe.pageCount }
}
