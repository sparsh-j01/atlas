import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
const { EVENTS } = await import('../logger')

// The logger prints any message not in EVENTS as "unrecognized event" (security review F05:
// messages must be fixed strings, never exception text). That makes an unregistered event a
// silent loss of the log line, so every call site is checked here instead of in production.
const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : /\.tsx?$/.test(e.name) && !/test/.test(e.name) ? [join(dir, e.name)] : [],
  )

describe('logger call sites', () => {
  const calls = ['app', 'lib'].flatMap(files).flatMap((f) =>
    [...readFileSync(f, 'utf8').matchAll(/logger\.(?:debug|info|warn|error)\(\s*([^,)]*)/g)].map((m) => ({ f, arg: m[1].trim() })),
  )

  it('found the call sites it is checking', () => {
    expect(calls.length).toBeGreaterThan(15)
  })

  it.each(calls)('$f logs a registered literal event: $arg', ({ arg }) => {
    const literal = arg.match(/^'([^']*)'$/)
    expect(literal, 'event must be a string literal').not.toBeNull()
    expect(EVENTS.has(literal![1])).toBe(true)
  })
})
