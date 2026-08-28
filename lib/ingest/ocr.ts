import { existsSync } from 'node:fs'
import path from 'node:path'

// Text recovery from images embedded in a slide deck.
//
// SCOPE, deliberately narrow: this reads images that are ALREADY image files, sitting in
// ppt/media/ inside the uploaded .pptx. It does not rasterize anything. Scanned PDFs need
// a page rasterizer (a native canvas binding) before OCR could see them at all, and that
// is a separate piece of work — see docs/plan.md → deferred.
//
// It runs LOCALLY on wasm, so a slide deck costs nothing per image in provider spend. That
// is the reason this is tesseract rather than a vision model: OCR of a lecture screenshot
// is a solved, unglamorous problem, and paying per image to re-solve it would make PPTX
// ingestion cost more than the PDF path it is meant to undercut.
//
// The traineddata ships in the repo rather than being fetched from tesseract's CDN. A
// serverless filesystem does not survive between invocations, so a CDN fetch would
// re-download ~10MB on every cold start, inside a 60-second budget, and add a third-party
// runtime dependency to a path that handles user uploads.

/** Formats tesseract cannot read. EMF and WMF are vector metafiles — there is no raster
 *  for the engine to look at — and SVG is markup, whose text is not in an image at all. */
export const OCR_UNREADABLE_TYPES: readonly string[] = ['image/x-emf', 'image/x-wmf', 'image/svg+xml']

export function canOcr(mimeType: string): boolean {
  return mimeType.startsWith('image/') && !OCR_UNREADABLE_TYPES.includes(mimeType)
}

/** Recognized text is only worth keeping if it looks like language. Tesseract returns
 *  confident nonsense for photographs and gradients — a handful of punctuation and stray
 *  letters — and storing that would poison retrieval with text no document contains. */
export const MIN_OCR_CHARS = 12

export function isUsableOcrText(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed.length < MIN_OCR_CHARS) return false
  // At least half of it should be letters, digits or spaces.
  const meaningful = (trimmed.match(/[\p{L}\p{N}\s]/gu) ?? []).length
  return meaningful / trimmed.length >= 0.5
}

/** Collapse the whitespace tesseract emits around layout, without joining words. */
export function normalizeOcrText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** One image in, its text out. Injected so the pipeline can be tested without wasm. */
export type Recognizer = (bytes: Uint8Array, mimeType: string) => Promise<string>

/** Held open across a stage run: loading the wasm core and the language data costs
 *  seconds, and doing it per image would exhaust the request budget on a deck of forty. */
export interface OcrEngine {
  recognize: Recognizer
  close: () => Promise<void>
}

/**
 * An installed package's directory, as a real path on disk.
 *
 * Built by joining strings rather than by module resolution, because module resolution does
 * not survive the bundler: `require.resolve(...)` gets rewritten to a bundler-internal
 * specifier (`[externals]/tesseract.js/...`) that Node's worker loader rejects for not being
 * an absolute path, and giving it a computed argument makes the bundler try to resolve the
 * dependency at build time and fail outright. A plain join is invisible to it.
 *
 * Both failures were found by running a real .pptx through the real route. Neither is
 * reachable from a unit test, because no bundler is involved outside the app.
 */
function packageDir(pkg: string): string {
  const candidates = [
    path.join(process.cwd(), 'node_modules', pkg),
    // Vercel puts the function's code under its own root; node_modules sits beside it.
    path.join(process.cwd(), '..', 'node_modules', pkg),
  ]
  const found = candidates.find((c) => existsSync(path.join(c, 'package.json')))
  // Loud rather than silent: without this the worker spawn fails deep inside tesseract with
  // a message that does not name the cause.
  if (!found) throw new Error(`OCR cannot find the installed "${pkg}" package`)
  return found
}

/** Where the bundled language data lives. tesseract.js appends "<lang>.traineddata.gz". */
export function tessdataPath(): string {
  return path.join(process.cwd(), 'lib', 'ingest', 'tessdata')
}

export async function createTesseractEngine(): Promise<OcrEngine> {
  const { createWorker } = await import('tesseract.js')
  const worker = await createWorker('eng', undefined, {
    // Both point at files on disk. Nothing is fetched at runtime.
    langPath: tessdataPath(),
    corePath: packageDir('tesseract.js-core'),
    // Resolved from the installed package rather than left to tesseract's own guess. Its
    // guess is derived from __dirname, which a bundler rewrites — and when the resulting
    // path is wrong the worker spawn fails as an uncaughtException that no await can catch,
    // so the stage hangs for the whole request budget instead of failing. next.config.ts
    // also marks the package external; this is the half that does not depend on that.
    workerPath: path.join(packageDir('tesseract.js'), 'src', 'worker-script', 'node', 'index.js'),
    gzip: true,
  })

  return {
    async recognize(bytes) {
      const { data } = await worker.recognize(Buffer.from(bytes))
      return normalizeOcrText(data.text ?? '')
    },
    async close() {
      await worker.terminate()
    },
  }
}
