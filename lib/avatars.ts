// Deterministic avatar from a nickname seed — DiceBear's HTTP API returns an SVG, so
// there's nothing to store or moderate. Same seed → same face.
export function avatarUrl(seed: string): string {
  return `https://api.dicebear.com/9.x/thumbs/svg?seed=${encodeURIComponent(seed)}`
}
