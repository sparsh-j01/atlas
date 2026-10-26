import { config } from 'dotenv'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { geminiGenerate } from '@/lib/ai/gemini'
import { readZipEntries } from '@/lib/ingest/zip'
import { mimeOf } from '@/lib/ingest/pptx'
import { imageDimensions, imageTokenCeiling, ocrModel, planBatches, transcribeBatch } from '@/lib/ingest/ocr'
import { tokenF1 } from './score'

config({ path: '.env.local', quiet: true })

/**
 * The OCR answer key: the gate for running OCR on the cheaper model (eng review 2026-10-05,
 * outside voice 7). Two models agreeing proves nothing about either, so each is scored
 * against a transcript a PERSON has checked.
 *
 * The key, and the decks it reads, stay local (docs/ is git-ignored): they are a teacher's
 * own lecture material and this repo is public. Only the scorer is committed.
 *
 *   npm run eval:ocr -- --draft   read docs/evals/ocr-key-spec.json, transcribe each image
 *                                 with the stronger model, write a DRAFT key to check by hand
 *   npm run eval:ocr              score OCR_MODEL and gemini-3.7-flash against the key
 *
 * Gate: the OCR model's mean token F1 is at least GATE_F1 and within GATE_MARGIN of 3.7
 * Flash. A key with unchecked entries still scores, but the run says so and cannot pass.
 * Env: OCR_EVAL_DIR (where the decks named in the spec live).
 */

const SPEC = 'docs/evals/ocr-key-spec.json'
const KEY = 'docs/evals/ocr-answer-key.json'
const REFERENCE_MODEL = 'gemini-3.7-flash'
const GATE_F1 = 0.9
const GATE_MARGIN = 0.03

type Entry = { deck: string; entry: string; kind: 'image-only' | 'mixed'; text?: string; checked?: boolean }

function loadImages(entries: Entry[]) {
  const dir = process.env.OCR_EVAL_DIR
  if (!dir) throw new Error('set OCR_EVAL_DIR to the folder holding the decks named in the key')
  const decks = new Map<string, Map<string, Uint8Array>>()
  return entries.map((e) => {
    if (!decks.has(e.deck)) {
      const file = path.join(dir, e.deck)
      if (!existsSync(file)) throw new Error(`deck not found: ${file}`)
      decks.set(e.deck, new Map(readZipEntries(new Uint8Array(readFileSync(file))).map((z) => [z.path, z.bytes])))
    }
    const bytes = decks.get(e.deck)!.get(e.entry)
    if (!bytes) throw new Error(`${e.entry} not in ${e.deck}`)
    const mimeType = mimeOf(e.entry, bytes)
    const dims = imageDimensions(bytes, mimeType)
    if (!dims) throw new Error(`cannot read the header of ${e.deck}:${e.entry}`)
    return { bytes, mimeType, tokenCeiling: imageTokenCeiling(dims) }
  })
}

async function transcribeAll(model: string, images: ReturnType<typeof loadImages>): Promise<string[]> {
  const generate = geminiGenerate(model)
  const indexed = images.map((img, i) => ({ ...img, i }))
  const out: string[] = new Array(images.length).fill('')
  for (const batch of planBatches(indexed)) {
    const res = await transcribeBatch(generate, batch, Date.now() + 90_000)
    if (!res.ok) throw new Error(`${model}: a batch failed${res.budget ? ' (AI budget)' : ''}`)
    batch.forEach((b, j) => (out[b.i] = res.texts[j]))
  }
  return out
}

async function main(): Promise<void> {
  if (process.argv.includes('--draft')) {
    const spec = JSON.parse(readFileSync(SPEC, 'utf8')) as Entry[]
    const texts = await transcribeAll(REFERENCE_MODEL, loadImages(spec))
    writeFileSync(KEY, JSON.stringify(spec.map((e, i) => ({ ...e, text: texts[i], checked: false })), null, 2) + '\n')
    console.log(`draft key written to ${KEY}: ${spec.length} entries, every one "checked": false.`)
    console.log('Read each text against its slide, fix any mistake, and set "checked": true.')
    process.exit(0)
  }

  const key = JSON.parse(readFileSync(KEY, 'utf8')) as Entry[]
  const images = loadImages(key)
  const unchecked = key.filter((e) => !e.checked).length
  const results: Record<string, number[]> = {}
  // A Set: when OCR_MODEL is the reference model itself, score it once.
  for (const model of new Set([ocrModel(), REFERENCE_MODEL])) {
    const texts = await transcribeAll(model, images)
    results[model] = key.map((e, i) => tokenF1(e.text ?? '', texts[i]))
  }

  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
  console.log('========== OCR ANSWER KEY ==========')
  key.forEach((e, i) =>
    console.log(`  ${e.kind.padEnd(10)} ${e.deck}:${e.entry.replace('ppt/media/', '')}`.padEnd(48) +
      Object.keys(results).map((m) => `${m}=${results[m][i].toFixed(3)}`).join('  ')))
  const lite = mean(results[ocrModel()])
  const ref = mean(results[REFERENCE_MODEL])
  console.log(`\nmean F1: ${ocrModel()}=${lite.toFixed(3)}  ${REFERENCE_MODEL}=${ref.toFixed(3)}`)
  const pass = unchecked === 0 && lite >= GATE_F1 && lite >= ref - GATE_MARGIN
  if (unchecked) console.log(`${unchecked}/${key.length} entries are not human-checked yet: the gate cannot pass until they are.`)
  console.log(`GATE (F1 >= ${GATE_F1} and within ${GATE_MARGIN} of ${REFERENCE_MODEL}): ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}

main().catch((err) => {
  console.error('OCR answer-key evaluation failed:', err)
  process.exit(1)
})
