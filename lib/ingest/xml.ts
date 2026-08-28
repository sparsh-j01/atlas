// A tag scanner, not an XML parser.
//
// The extractor needs three things from slide markup: text runs in document order, the
// table/row/cell boundaries around them, and image relationship ids. That is a walk over
// the tag stream, so this walks the tag stream — rather than adding an XML dependency to
// hold a tree nobody queries.
//
// It is deliberately tolerant. Slide XML arrives inside a file a user uploaded, so the
// scanner must not throw on malformed markup; unbalanced tags produce worse text, never
// an exception. The caller decides what counts as unreadable.
//
// ponytail: no namespace resolution — tags are matched on their literal prefixed name
// (`a:t`, `a:tbl`), which is what every PowerPoint writer emits. Upgrade path if a
// producer ever remaps the DrawingML prefix: a real parser.

export interface XmlTag {
  /** Tag name as written, including any prefix: "a:t", "p:sp". */
  name: string
  kind: 'open' | 'close' | 'self'
  /** Raw attribute text; read with attr(). */
  raw: string
}

export type XmlToken = XmlTag | { kind: 'text'; value: string }

// Entities are decoded HERE, once, as text leaves the scanner — so no caller can decode a
// second time and no caller can forget to decode at all. CDATA is the one exception: its
// content is literal by definition, so "&amp;" inside it stays "&amp;".

/** Walk an XML string, yielding tags and the text between them, in document order. */
export function* scanXml(xml: string): Generator<XmlToken> {
  let i = 0
  while (i < xml.length) {
    const lt = xml.indexOf('<', i)
    if (lt < 0) {
      const tail = xml.slice(i)
      if (tail) yield { kind: 'text', value: decodeEntities(tail) }
      return
    }
    if (lt > i) yield { kind: 'text', value: decodeEntities(xml.slice(i, lt)) }

    // Comments, CDATA, doctypes and processing instructions carry no slide content.
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4)
      i = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9)
      // Literal by definition — not decoded.
      yield { kind: 'text', value: end < 0 ? xml.slice(lt + 9) : xml.slice(lt + 9, end) }
      i = end < 0 ? xml.length : end + 3
      continue
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const end = xml.indexOf('>', lt)
      i = end < 0 ? xml.length : end + 1
      continue
    }

    // `>` is legal, unescaped, inside a quoted attribute value, so the scan for the tag's
    // end has to respect quotes rather than indexOf('>').
    let j = lt + 1
    let quote: string | null = null
    while (j < xml.length) {
      const c = xml[j]
      if (quote) {
        if (c === quote) quote = null
      } else if (c === '"' || c === "'") {
        quote = c
      } else if (c === '>') break
      j++
    }
    if (j >= xml.length) return // truncated tag: nothing further is readable

    const inner = xml.slice(lt + 1, j)
    const isClose = inner.startsWith('/')
    const isSelf = inner.endsWith('/')
    const body = inner.slice(isClose ? 1 : 0, isSelf ? -1 : undefined)
    const space = body.search(/\s/)
    const name = (space < 0 ? body : body.slice(0, space)).trim()
    if (name)
      yield { name, kind: isClose ? 'close' : isSelf ? 'self' : 'open', raw: space < 0 ? '' : body.slice(space) }
    i = j + 1
  }
}

/** Read one attribute off a tag's raw attribute text. */
export function attr(raw: string, name: string): string | undefined {
  const m = raw.match(new RegExp(`(?:^|\\s)${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`))
  if (!m) return undefined
  return decodeEntities(m[2] ?? m[3] ?? '')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Decode XML entities EXACTLY ONCE.
 *
 * Decoding twice is the bug this exists to prevent: "&amp;lt;" is the literal text
 * "&lt;", and a second pass turns it into "<", inventing markup the document never
 * contained. Every branch below consumes its input and never revisits its own output.
 */
export function decodeEntities(s: string): string {
  if (!s.includes('&')) return s
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      // Reject non-characters and anything out of range rather than emitting U+FFFD noise.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return whole
      return String.fromCodePoint(code)
    }
    const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    return named[body] ?? whole
  })
}
