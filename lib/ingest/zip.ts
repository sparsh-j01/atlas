import { inflateRawSync } from 'node:zlib'

// Reading a .pptx means inflating an archive an untrusted user uploaded, which the PDF
// path never had to do. The upload route's 25MB cap bounds COMPRESSED bytes, and DEFLATE
// reaches roughly 1000:1 on repetitive input — so a 1MB upload that passes every check in
// the route can decompress to gigabytes and take the function's memory with it.
//
// Four limits, each catching what the one before it cannot:
//
//   entry count ─> declared total ─> per-entry inflate cap ─> running inflated total
//      cheap           cheap              authoritative           authoritative
//
// The first two read the central directory only. They cost nothing and are worthless on
// their own: the central directory is attacker-controlled and a crafted archive can
// under-report every size in it. The last two are the real guard — zlib's maxOutputLength
// stops an individual bomb mid-inflate, and the running total stops a thousand small ones.
//
// Entries are filtered BEFORE inflating: anything outside the prefixes a .pptx is read
// from never gets decompressed at all.
//
// ponytail: node:zlib + ~60 lines of central-directory parsing instead of a zip
// dependency. Upgrade path if this ever needs zip64, encryption or streaming: take the dep.

/** Inflated bytes across all read entries. A 25MB pptx of slide XML lands far under this;
 *  anything above it is not a presentation. */
export const MAX_INFLATED_BYTES = 200 * 1024 * 1024

/** A 200-slide deck with media and rels sits in the low thousands of entries. Millions of
 *  empty entries is a different attack — cheap to produce, expensive to iterate. */
export const MAX_ENTRIES = 2_000

/** The only paths inside a .pptx this codebase reads. Matched with startsWith on the exact
 *  prefix, never `includes`: "evil/ppt/media/x.png" must NOT match "ppt/media/". */
export const PPTX_ALLOWED_PREFIXES = [
  'ppt/slides/',
  'ppt/notesSlides/',
  'ppt/media/',
] as const

export class ZipLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipLimitError'
  }
}

export function isAllowedPptxPath(path: string, prefixes: readonly string[] = PPTX_ALLOWED_PREFIXES): boolean {
  // Zip entry names are attacker-controlled strings, not filesystem paths. Traversal and
  // absolute names are rejected outright rather than normalised — there is no legitimate
  // .pptx entry containing "..", a leading "/", or a backslash.
  if (path.includes('..') || path.startsWith('/') || path.includes('\\')) return false
  return prefixes.some((p) => path.startsWith(p))
}

export interface ZipEntry {
  path: string
  bytes: Uint8Array
}

interface CentralEntry {
  path: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localHeaderOffset: number
}

/**
 * Inflate the allowed entries of a zip, refusing to exceed the limits above.
 *
 * Returns entries in archive order. Throws ZipLimitError when a limit trips — the caller
 * turns that into a failed upload, never a partial read, because a partial read of a
 * presentation is indistinguishable from a presentation that is genuinely short.
 */
export function readZipEntries(
  data: Uint8Array,
  opts: { prefixes?: readonly string[]; maxInflated?: number; maxEntries?: number } = {},
): ZipEntry[] {
  const prefixes = opts.prefixes ?? PPTX_ALLOWED_PREFIXES
  const maxInflated = opts.maxInflated ?? MAX_INFLATED_BYTES
  const maxEntries = opts.maxEntries ?? MAX_ENTRIES

  const central = readCentralDirectory(data)
  if (central.length > maxEntries)
    throw new ZipLimitError(`archive has ${central.length} entries, limit is ${maxEntries}`)

  const declared = central.reduce((n, e) => n + e.uncompressedSize, 0)
  if (declared > maxInflated)
    throw new ZipLimitError(`archive declares ${declared} uncompressed bytes, limit is ${maxInflated}`)

  const entries: ZipEntry[] = []
  let total = 0
  for (const e of central) {
    if (!isAllowedPptxPath(e.path, prefixes)) continue

    // The remaining budget, not the whole cap: a thousand entries each just under the
    // limit would otherwise pass one at a time and blow it collectively.
    const budget = maxInflated - total
    const bytes = inflateEntry(data, e, budget)
    total += bytes.length
    entries.push({ path: e.path, bytes })
  }
  return entries
}

function inflateEntry(data: Uint8Array, entry: CentralEntry, budget: number): Uint8Array {
  if (budget <= 0) throw new ZipLimitError(`inflated output exceeded the limit`)

  // The local header's name and extra fields can be sized differently from the central
  // directory's copy, so the data offset must come from the local header itself.
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const lh = entry.localHeaderOffset
  if (lh + 30 > data.byteLength || view.getUint32(lh, true) !== LOCAL_SIGNATURE)
    throw new Error(`corrupt local header for "${entry.path}"`)

  const start = lh + 30 + view.getUint16(lh + 26, true) + view.getUint16(lh + 28, true)
  const end = start + entry.compressedSize
  if (end > data.byteLength) throw new Error(`truncated entry "${entry.path}"`)
  const compressed = data.subarray(start, end)

  if (entry.method === 0) {
    // Stored. No expansion is possible, but it still spends the budget.
    if (compressed.length > budget) throw new ZipLimitError(`inflated output exceeded the limit`)
    return compressed
  }
  if (entry.method !== 8) throw new Error(`unsupported compression method ${entry.method} for "${entry.path}"`)

  try {
    // maxOutputLength aborts the inflate itself rather than measuring the result, so a
    // 4GB bomb never allocates 4GB to be rejected afterwards.
    return inflateRawSync(compressed, { maxOutputLength: budget })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/maxOutputLength|buffer|memory/i.test(message))
      throw new ZipLimitError(`entry "${entry.path}" inflates past the ${MAX_INFLATED_BYTES}-byte limit`)
    throw new Error(`could not inflate "${entry.path}"`)
  }
}

// --- Central directory ------------------------------------------------------

const LOCAL_SIGNATURE = 0x04034b50
const CD_SIGNATURE = 0x02014b50
const EOCD_SIGNATURE = 0x06054b50

function findEndOfCentralDirectory(view: DataView): number {
  // The EOCD sits at the end, after a comment field of up to 64KB. Scan backwards.
  const min = Math.max(0, view.byteLength - 22 - 0xffff)
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) return i
  }
  return -1
}

function readCentralDirectory(data: Uint8Array): CentralEntry[] {
  if (data.byteLength < 22) return []
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const eocd = findEndOfCentralDirectory(view)
  if (eocd < 0) return []

  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const entries: CentralEntry[] = []

  for (let i = 0; i < count; i++) {
    // A truncated or lying directory walks off the end; stop rather than throw, and let the
    // caller's own checks decide the archive's fate.
    if (offset + 46 > data.byteLength) break
    if (view.getUint32(offset, true) !== CD_SIGNATURE) break

    const nameLen = view.getUint16(offset + 28, true)
    const extraLen = view.getUint16(offset + 30, true)
    const commentLen = view.getUint16(offset + 32, true)
    entries.push({
      path: decoder.decode(data.subarray(offset + 46, offset + 46 + nameLen)),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** Entry names as the archive declares them, without inflating anything. */
export function listEntryNames(data: Uint8Array): string[] {
  return readCentralDirectory(data).map((e) => e.path)
}

/** What the archive CLAIMS it inflates to. Advisory — see the running counter above. */
export function declaredUncompressedTotal(data: Uint8Array): number {
  return readCentralDirectory(data).reduce((n, e) => n + e.uncompressedSize, 0)
}
