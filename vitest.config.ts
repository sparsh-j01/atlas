import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['lib/**/*.test.ts', 'lib/**/__tests__/*.test.ts', 'evals/**/*.test.ts'],
    // No `exclude`. Server modules pull in `server-only`, which throws outside a
    // React Server Component; the tests that touch them stub it with
    // `vi.mock('server-only', () => ({}))` instead. Excluding a failing file here
    // makes the suite report green while the risky code goes untested — that is
    // how four runtime blockers shipped behind "142 tests passing".
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
})
