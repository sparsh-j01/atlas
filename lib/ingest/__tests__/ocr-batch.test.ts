import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  BATCH_MAX_BYTES,
  BATCH_MAX_IMAGES,
  MAX_IMAGE_TILES,
  imageDimensions,
  imageTiles,
  imageTokenCeiling,
  planBatches,
  transcribeBatch,
  withDiagram,
} from '../ocr'

const png = new Uint8Array(readFileSync(path.join(__dirname, 'fixtures', 'ocr-sample.png')))

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment to skip over, then SOF0 carrying height then width.
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
  ])
}

function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(30)
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0)
  b.set([...'WEBPVP8X'].map((c) => c.charCodeAt(0)), 8)
  const w = width - 1
  const h = height - 1
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24)
  return b
}

describe('imageDimensions', () => {
  it('reads a real PNG header', () => {
    expect(imageDimensions(png, 'image/png')).toEqual({ width: 720, height: 144 })
  })

  it('walks JPEG segments to the frame header', () => {
    expect(imageDimensions(jpeg(1920, 1080), 'image/jpeg')).toEqual({ width: 1920, height: 1080 })
  })

  it('reads an extended WebP header', () => {
    expect(imageDimensions(webpVp8x(1280, 720), 'image/webp')).toEqual({ width: 1280, height: 720 })
  })

  it('returns null for a header it cannot read, so the image is never sent unbounded', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3]), 'image/png')).toBeNull()
    expect(imageDimensions(png, 'image/jpeg')).toBeNull()
  })
})

describe('image token ceilings', () => {
  it('follows the documented tiling: 1 tile when small, crop units otherwise', () => {
    expect(imageTiles({ width: 300, height: 200 })).toBe(1)
    // The documented example: 960x540, crop unit 360, 3 x 2 tiles.
    expect(imageTiles({ width: 960, height: 540 })).toBe(6)
  })

  it('never reserves below the measured cost of a real slide, nor below Gemini 3 per-image', () => {
    expect(imageTokenCeiling({ width: 1920, height: 1080 })).toBeGreaterThanOrEqual(1120)
    expect(imageTokenCeiling({ width: 300, height: 200 })).toBe(1400)
  })

  it('flags a long thin image as too large to bound', () => {
    expect(imageTiles({ width: 4000, height: 300 })).toBeGreaterThan(MAX_IMAGE_TILES)
    expect(imageTiles({ width: 1920, height: 1080 })).toBeLessThanOrEqual(MAX_IMAGE_TILES)
  })
})

describe('planBatches', () => {
  const item = (n: number) => ({ bytes: new Uint8Array(n) })

  it('caps a batch by image count', () => {
    const batches = planBatches(Array.from({ length: BATCH_MAX_IMAGES + 1 }, () => item(10)))
    expect(batches.map((b) => b.length)).toEqual([BATCH_MAX_IMAGES, 1])
  })

  it('caps a batch by total bytes, so a request stays under Gemini 20MB limit', () => {
    const big = Math.floor(BATCH_MAX_BYTES / 2) + 1
    expect(planBatches([item(big), item(big), item(10)]).map((b) => b.length)).toEqual([1, 2])
  })

  it('keeps slide order and gives an oversized image a batch of its own', () => {
    const items = [item(5), item(BATCH_MAX_BYTES + 1), item(5)]
    expect(planBatches(items)).toEqual([[items[0]], [items[1]], [items[2]]])
  })
})

describe('transcribeBatch', () => {
  const images = [1, 2, 3].map(() => ({ bytes: png, mimeType: 'image/png', tokenCeiling: 1400 }))

  it('maps each answer to its own image, appends repeated numbers, ignores skipped or invented ones', async () => {
    const generate = vi.fn(async () => ({
      ok: true as const,
      input: { images: [{ image: 2, text: 'Second  slide\n\n' }, { image: 2, text: 'dup' }, { image: 9, text: 'invented' }, { image: 1, text: 'First' }] },
    }))
    const res = await transcribeBatch(generate, images, Date.now() + 60_000)
    // A repeat is the model splitting one image into several entries (one per diagram box).
    expect(res).toEqual({ ok: true, texts: ['First', 'Second slide\ndup', ''], diagrams: ['', '', ''] })
    const [args] = generate.mock.calls[0] as unknown as [{ images: { tokenCeiling: number }[]; maxOutputTokens: number }]
    expect(args.images.map((i) => i.tokenCeiling)).toEqual([1400, 1400, 1400])
    expect(args.maxOutputTokens).toBe(3 * 2048)
  })

  it('keeps a diagram reading apart from the transcription, joined across split entries', async () => {
    const generate = vi.fn(async () => ({
      ok: true as const,
      input: {
        images: [
          { image: 1, text: 'TCP', diagram: 'SSL Record Protocol\\nsits on TCP,' },
          { image: 1, text: 'IP', diagram: '  which runs on IP.' },
          { image: 2, text: 'Just bullets', diagram: '' },
          { image: 3, text: 'No field at all' },
        ],
      },
    }))
    const res = await transcribeBatch(generate, images, Date.now() + 60_000)
    expect(res).toEqual({
      ok: true,
      texts: ['TCP\nIP', 'Just bullets', 'No field at all'],
      diagrams: ['SSL Record Protocol sits on TCP, which runs on IP.', '', ''],
    })
  })

  it('stores the diagram reading on its own labelled line, and nothing extra without one', () => {
    expect(withDiagram('TCP\nIP', 'SSL runs on TCP.')).toBe('TCP\nIP\n[Diagram, as read by AI]: SSL runs on TCP.')
    expect(withDiagram('Just bullets', '')).toBe('Just bullets')
  })

  it('reports a budget refusal distinctly from other failures', async () => {
    const refused = vi.fn(async () => ({ ok: false as const, error: 'paused', budget: true as const }))
    expect(await transcribeBatch(refused, images, Date.now() + 60_000)).toEqual({ ok: false, budget: true })
    const failed = vi.fn(async () => ({ ok: false as const, error: 'provider returned 500' }))
    expect(await transcribeBatch(failed, images, Date.now() + 60_000)).toEqual({ ok: false, budget: false })
  })
})

describe('unescapeLayout', () => {
  it('turns a model\'s double-escaped newlines and tabs back into layout', async () => {
    const { unescapeLayout, normalizeOcrText } = await import('../ocr')
    // gemini-3.7-flash, verbatim (as a JS string: backslash then n).
    const raw = 'Handshake\\nProtocol\\tChange Cipher\\nSpec Protocol'
    expect(normalizeOcrText(unescapeLayout(raw))).toBe('Handshake\nProtocol Change Cipher\nSpec Protocol')
    expect(unescapeLayout('already\nreal')).toBe('already\nreal')
  })
})
