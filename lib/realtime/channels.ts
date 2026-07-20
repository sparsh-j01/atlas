// Realtime channel naming. One channel per live session, keyed by the 6-digit code.
// Spec: docs/schema.md → "Realtime contracts".
export const sessionChannel = (code: string) => `session:${code}`
