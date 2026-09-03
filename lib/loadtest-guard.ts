/**
 * The concurrent-connection ceiling for a load-test run, and whether a run may cross it.
 *
 * One websocket per simulated participant plus the host console. The ceiling is a hard
 * quota, not a soft one: crossing it flags the whole ORGANISATION over quota, which
 * restricts every project, not just the run that did it.
 *
 * **Free has no override.** This org already spent its one grace period on a 250-connection
 * run in July 2026; the grace period ended 30 Aug 2026, so the next crossing returns 402 on
 * every request immediately, with no warning window. On a paid plan an overage is a line on
 * a bill and `LOADTEST_ALLOW_OVER=1` is a real choice; on free it is an outage, and there is
 * nothing to buy your way over with — so the override is ignored there.
 *
 * An unrecognised plan name falls back to free, which also means it falls back to *no
 * override*. That is the safe direction for a typo.
 */
export const PLAN_CONNECTION_LIMIT = { free: 200, pro: 500 } as const

export type Plan = keyof typeof PLAN_CONNECTION_LIMIT

export function resolvePlan(name: string | undefined): { plan: Plan; limit: number } {
  const plan = name && name in PLAN_CONNECTION_LIMIT ? (name as Plan) : 'free'
  return { plan, limit: PLAN_CONNECTION_LIMIT[plan] }
}

/** `connections` is N clients + 1 for the host console. True = refuse the run. */
export function blocksRun(connections: number, plan: Plan, allowOver: boolean): boolean {
  if (connections <= PLAN_CONNECTION_LIMIT[plan]) return false
  return plan === 'free' || !allowOver
}
