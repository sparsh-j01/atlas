import { deflateRawSync } from 'node:zlib'

// Minimal zip writer, so the zip tests exercise real archives rather than mocks. Only what
// readZipEntries reads is filled in: CRCs are left zero because nothing in the reader
// checks them, and no zip64 or encryption is emitted.

export interface FixtureFile {
  path: string
  /** Contents. A string is encoded UTF-8. */
  data: string | Uint8Array
  /** 8 = deflate (default), 0 = stored. */
  method?: 0 | 8
  /** Override what the central directory CLAIMS this inflates to, to model an archive
   *  that lies about its own sizes. */
  declaredSize?: number
}

export function buildZip(files: FixtureFile[]): Uint8Array {
  const enc = new TextEncoder()
  const local: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const f of files) {
    const name = enc.encode(f.path)
    const raw = typeof f.data === 'string' ? enc.encode(f.data) : f.data
    const method = f.method ?? 8
    const body = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw
    const declared = f.declaredSize ?? raw.length

    const lh = new Uint8Array(30 + name.length)
    const lv = new DataView(lh.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, method, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, declared, true)
    lv.setUint16(26, name.length, true)
    lh.set(name, 30)
    local.push(lh, body)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, method, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, declared, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    central.push(cd)

    offset += lh.length + body.length
  }

  const centralSize = central.reduce((n, b) => n + b.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  return concat([...local, ...central, eocd])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** Wrap slide XML in the shape PowerPoint emits, so pptx tests read realistic markup. */
export function slideXml(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
    ' xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    `<p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`
  )
}

/** A text-bearing shape: one paragraph per string. */
export function textShape(...paragraphs: string[]): string {
  const paras = paragraphs.map((p) => `<a:p><a:r><a:t>${p}</a:t></a:r></a:p>`).join('')
  return `<p:sp><p:txBody>${paras}</p:txBody></p:sp>`
}

/** A table: rows of cells, each cell one paragraph. */
export function tableShape(rows: string[][]): string {
  const trs = rows
    .map(
      (cells) =>
        '<a:tr>' +
        cells.map((c) => `<a:tc><a:txBody><a:p><a:r><a:t>${c}</a:t></a:r></a:p></a:txBody></a:tc>`).join('') +
        '</a:tr>',
    )
    .join('')
  return `<p:graphicFrame><a:graphic><a:graphicData><a:tbl>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
}

/** A picture shape referencing a relationship id. */
export function pictureShape(rId: string): string {
  return `<p:pic><p:blipFill><a:blip r:embed="${rId}"/></p:blipFill></p:pic>`
}

/** The _rels sidecar mapping relationship ids to media paths. */
export function relsXml(map: Record<string, string>): string {
  const rels = Object.entries(map)
    .map(([id, target]) => `<Relationship Id="${id}" Target="${target}"/>`)
    .join('')
  return `<?xml version="1.0"?><Relationships>${rels}</Relationships>`
}
