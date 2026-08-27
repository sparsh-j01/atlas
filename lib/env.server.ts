import 'server-only'
import { required } from './env'

// Server-only secrets. `import 'server-only'` turns any accidental client import into
// a build error — defense in depth (these non-NEXT_PUBLIC vars are undefined client-side
// anyway, so they can't leak, but the build guard catches the mistake early). Getters
// validate lazily on first use, not at import, so importing this file never throws for a
// var a given code path doesn't touch.
export const serverEnv = {
  get serviceRoleKey() {
    return required('SUPABASE_SERVICE_ROLE_KEY')
  },
  get databaseUrl() {
    return required('DATABASE_URL')
  },
  get directUrl() {
    return required('DIRECT_URL')
  },
  // M6 generation provider (Gemini by default; see lib/ai/generate.ts for the swap point).
  // Read lazily so a missing key only fails an actual generation call.
  get geminiKey() {
    return required('GEMINI_API_KEY')
  },
}
