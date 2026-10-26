/** Words, lowercased, letters and digits only: layout, bullets and line breaks are not what
 *  OCR quality means here; which words came back is. */
export function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/** F1 over word multisets: recall punishes dropped words, precision invented ones. Two empty
 *  texts agree perfectly (an image with no text, read as none). */
export function tokenF1(expected: string, actual: string): number {
  const want = words(expected)
  const got = words(actual)
  if (want.length === 0 && got.length === 0) return 1
  if (want.length === 0 || got.length === 0) return 0
  const counts = new Map<string, number>()
  for (const w of want) counts.set(w, (counts.get(w) ?? 0) + 1)
  let hit = 0
  for (const w of got) {
    const n = counts.get(w) ?? 0
    if (n > 0) {
      hit++
      counts.set(w, n - 1)
    }
  }
  const precision = hit / got.length
  const recall = hit / want.length
  return precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
}
