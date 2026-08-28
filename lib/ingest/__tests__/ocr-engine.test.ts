import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { createTesseractEngine, isUsableOcrText, tessdataPath } from '../ocr'

// The OCR engine, actually initialized and actually run.
//
// The rest of the OCR coverage is pure predicates over strings, which would all pass with a
// completely broken engine. This is the test that fails if the wasm core cannot load, if the
// bundled language data goes missing or moves, or if the worker script path stops resolving
// — all three of which HAVE happened during this milestone, and none of which any other test
// in the suite can see.
//
// It runs offline: no network, no API key, no database. The language data is committed at
// lib/ingest/tessdata/eng.traineddata.gz, so this is safe in CI.
//
// It is the slowest test here (wasm + ~10MB of language data), hence the explicit timeout.

const FIXTURE = path.join(__dirname, 'fixtures', 'ocr-sample.png')
const EXPECTED = 'Atlas reads slides'

describe('tesseract engine', () => {
  it('initializes and reads text out of a real PNG', { timeout: 60_000 }, async () => {
    const engine = await createTesseractEngine()
    try {
      const text = await engine.recognize(new Uint8Array(readFileSync(FIXTURE)), 'image/png')
      expect(text).toBe(EXPECTED)
      expect(isUsableOcrText(text)).toBe(true)
    } finally {
      await engine.close()
    }
  })

  it('resolves the language data from inside the repo, not a CDN', () => {
    // A serverless filesystem does not survive between invocations, so a CDN langPath would
    // re-download ~10MB on every cold start, inside a 60-second budget.
    const dir = tessdataPath()
    expect(dir).toContain(path.join('lib', 'ingest', 'tessdata'))
    expect(() => readFileSync(path.join(dir, 'eng.traineddata.gz'))).not.toThrow()
  })
})
