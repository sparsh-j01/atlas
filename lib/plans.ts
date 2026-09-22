// What each plan may do. Pure data, so the usage page, the routes and the tests share one copy.
// A creator's plan lives in the `entitlements` table (server-only); no row means 'free'.

export const PLANS = ['free', 'pro', 'university'] as const
export type Plan = (typeof PLANS)[number]

export function isPlan(v: unknown): v is Plan {
  return typeof v === 'string' && (PLANS as readonly string[]).includes(v)
}

export interface PlanLimits {
  /** AI deck runs, topic or document, counted when the run STARTS: a run that fails partway
   *  has still spent model calls, and counting only successes would make retry-until-it-works
   *  free. */
  aiDecksPerDay: number
  aiDecksPerMonth: number
  /** Whether the document path (upload, processing, generation from a file) is open. */
  documents: boolean
}

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  // ponytail: LENIENT on purpose (decided 2026-10-04). There is no way to pay yet, so the
  // advertised Free limits would lock every teacher out of the document path — the product's
  // main feature — with no way out. When billing lands, match app/pricing/page.tsx:
  //   free: { aiDecksPerDay: 3, aiDecksPerMonth: 3, documents: false }
  free: { aiDecksPerDay: 20, aiDecksPerMonth: 100, documents: true },
  // "Unlimited" on the pricing page means no ceiling a teacher meets in normal use, not none:
  // these exist so one compromised account cannot spend the month's budget in an afternoon.
  pro: { aiDecksPerDay: 50, aiDecksPerMonth: 500, documents: true },
  university: { aiDecksPerDay: 100, aiDecksPerMonth: 2000, documents: true },
}
