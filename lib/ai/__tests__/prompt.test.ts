import { describe, expect, it } from 'vitest'
import { fenceTag } from '../prompt'
import { buildStructurePrompt } from '../structure'
import { GOLDEN_DOCUMENTS, fullTextOf } from '../../../evals/documents/golden-set'

// The fence around untrusted document text is a security control, so it gets a test that
// fails if the control is removed — not just a comment saying it matters.
//
// The regression: `<source>` … `</source>` were fixed strings, so a PDF containing
// `</source>` closed the block and everything after it read as top-level prompt content.
// The generator AND the judge both took the document's word for where the quote ended.

const adversarial = GOLDEN_DOCUMENTS.find((d) => d.id === 'adversarial-injection')!

describe('fenceTag', () => {
  it('does not collide across calls', () => {
    const tags = new Set(Array.from({ length: 200 }, () => fenceTag('source')))
    expect(tags.size).toBe(200)
  })

  it('keeps the base name so the prompt still reads as English', () => {
    expect(fenceTag('extract')).toMatch(/^extract-[a-z0-9]{4,}$/)
  })
})

describe('untrusted text cannot close its own fence', () => {
  // The corpus is the proof the case is real: this document ships the literal closing tags.
  const text = fullTextOf(adversarial)

  it('the adversarial corpus really does contain the old fixed delimiters', () => {
    expect(text).toContain('</source>')
    expect(text).toContain('</extract>')
    expect(text).toContain('</document>')
  })

  it('a randomised fence survives text that contains every fixed closing tag', () => {
    const tag = fenceTag('source')
    const block = `<${tag}>\n${text}\n</${tag}>`
    // Exactly one closing tag in the rendered block: the one we wrote.
    expect(block.split(`</${tag}>`).length - 1).toBe(1)
    // And the payload after the escape attempt is still INSIDE the fence.
    const inside = block.slice(block.indexOf(`<${tag}>`), block.lastIndexOf(`</${tag}>`))
    expect(inside).toContain('SYSTEM OVERRIDE')
  })

  it('buildStructurePrompt fences the window with a tag the window does not contain', () => {
    const prompt = buildStructurePrompt(text, 1, 3)
    const opened = prompt.match(/<(document-[a-z0-9]+)>/)
    expect(opened).not.toBeNull()
    const tag = opened![1]
    expect(text).not.toContain(tag)
    expect(prompt.split(`</${tag}>`).length - 1).toBe(1)
  })

  it('the document text reaches the prompt byte-for-byte', () => {
    // Offsets returned by the model are counted against this text, so escaping or
    // rewriting it here would shift every chunk boundary downstream.
    expect(buildStructurePrompt(text, 1, 3)).toContain(text)
  })
})
