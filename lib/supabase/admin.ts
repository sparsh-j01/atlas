import 'server-only'
import { createClient } from '@supabase/supabase-js'
import { SUPABASE_URL } from '@/lib/env'
import { serverEnv } from '@/lib/env.server'

// Service-role client — BYPASSES RLS. Server-only. This mediates every anonymous
// participant action (join / answer / advance / reveal): the anon key never touches
// sessions/participants/answers. Never import into a client component.
export function createAdminClient() {
  return createClient(SUPABASE_URL, serverEnv.serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
