import { describe, expect, it } from 'vitest'
import { sha256 } from '@/lib/crypto'
import { checkUploadedBytes } from '../check-upload'
import { PPTX_FORMAT } from '../formats'
import { buildZip, slideXml, textShape } from './zip-fixtures'

const limits = { maxFileSize: 25 * 1024 * 1024, maxPages: 200 }
const deck = () => Buffer.from(buildZip([{ path: 'ppt/slides/slide1.xml', data: slideXml(textShape('Photosynthesis')) }]))

describe('checkUploadedBytes', () => {
  it('accepts a real deck whose bytes hash to the claimed fingerprint', async () => {
    const buf = deck()
    expect(await checkUploadedBytes(buf, PPTX_FORMAT, await sha256(buf), limits)).toEqual({ ok: true, pageCount: 1 })
  })

  it('refuses bytes that do not hash to the fingerprint the link was issued for', async () => {
    const buf = deck()
    const res = await checkUploadedBytes(buf, PPTX_FORMAT, 'f'.repeat(64), limits)
    expect(res).toMatchObject({ ok: false, status: 422 })
  })

  it('refuses before hashing when the size or signature is wrong', async () => {
    expect(await checkUploadedBytes(Buffer.alloc(0), PPTX_FORMAT, '', limits)).toMatchObject({ ok: false, status: 400 })
    const big = Buffer.alloc(11)
    expect(await checkUploadedBytes(big, PPTX_FORMAT, '', { ...limits, maxFileSize: 10 })).toMatchObject({ ok: false, status: 413 })
    const pdfBytes = Buffer.from('%PDF-1.4 not a deck')
    expect(await checkUploadedBytes(pdfBytes, PPTX_FORMAT, await sha256(pdfBytes), limits)).toMatchObject({ ok: false, status: 415 })
  })

  it('refuses a zip that hashes correctly but is not a deck', async () => {
    const notDeck = Buffer.from(buildZip([{ path: 'word/document.xml', data: '<w:document/>' }]))
    expect(await checkUploadedBytes(notDeck, PPTX_FORMAT, await sha256(notDeck), limits)).toMatchObject({ ok: false, status: 422 })
  })
})
