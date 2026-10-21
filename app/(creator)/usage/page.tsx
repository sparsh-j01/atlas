import { requireUser } from '@/lib/auth'
import { PLAN_LIMITS } from '@/lib/plans'
import { aiDeckCounts, getPlan, monthSpendMicroUsd, monthlyBudgetMicroUsd } from '@/lib/usage'
import { UPLOADS_PER_HOUR, recentUploadCount } from '@/lib/documents'
import { LocalTime } from '@/components/LocalTime'
import { tileCls } from '@/components/ui'

export const metadata = { title: 'Usage' }

const PLAN_NAME = { free: 'Free', pro: 'Pro', university: 'University' } as const
const DAY_MS = 24 * 60 * 60 * 1000

/** Everything the page shows, read at one instant. Outside the component so the clock read
 *  is not part of render. */
async function load(ownerId: string) {
  const now = Date.now()
  const [plan, decks, uploads, spent] = await Promise.all([
    getPlan(ownerId),
    aiDeckCounts(ownerId, now),
    recentUploadCount(ownerId, now),
    monthSpendMicroUsd(now),
  ])
  const d = new Date(now)
  return {
    plan,
    decks,
    uploads,
    nextDay: new Date(Math.floor(now / DAY_MS) * DAY_MS + DAY_MS),
    nextMonth: new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)),
    // Only whether the shared budget is spent, never the number: that is the operator's figure.
    paused: spent >= monthlyBudgetMicroUsd(),
  }
}

export default async function UsagePage() {
  const user = await requireUser()
  const { plan, decks, uploads, nextDay, nextMonth, paused } = await load(user.id)
  const limits = PLAN_LIMITS[plan]

  return (
    <div className="mx-auto max-w-3xl px-6 py-14">
      <h1 className="font-display text-[44px] leading-none">Usage</h1>
      <p className="mt-3 text-dim">
        {PLAN_NAME[plan]} plan. Hand-built decks and live classes are not counted — only the
        work that asks the AI to write questions or read a document.
      </p>

      {paused && (
        <p role="status" className="mt-8 rounded-plate border border-wrong/40 bg-wrong-wash p-4 text-sm text-wrong">
          AI generation is paused for everyone until <LocalTime iso={nextMonth.toISOString()} dateOnly />.
          Hand-built decks still work.
        </p>
      )}

      <ul className="mt-10 flex flex-col gap-3">
        <Meter
          label="AI decks today"
          used={decks.today}
          limit={limits.aiDecksPerDay}
          resets={nextDay.toISOString()}
        />
        <Meter
          label="AI decks this month"
          used={decks.month}
          limit={limits.aiDecksPerMonth}
          resets={nextMonth.toISOString()}
          dateOnly
        />
        {limits.documents && (
          <Meter label="Document uploads in the last hour" used={uploads} limit={UPLOADS_PER_HOUR} />
        )}
      </ul>

      <p className="mt-8 text-sm text-dim">
        A deck counts when generation starts, including one that does not finish: the AI has
        already done the work.
      </p>
    </div>
  )
}

function Meter({
  label,
  used,
  limit,
  resets,
  dateOnly = false,
}: {
  label: string
  used: number
  limit: number
  resets?: string
  dateOnly?: boolean
}) {
  const shown = Math.min(used, limit)
  const full = used >= limit
  return (
    <li className={`${tileCls} px-5 py-4`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className="font-semibold">{label}</span>
        <span className={`tabular text-sm ${full ? 'text-wrong' : 'text-dim'}`}>
          {shown} of {limit}
        </span>
      </div>
      {/* The numbers above are the accessible reading; the bar only repeats them. */}
      <div aria-hidden className="mt-3 h-1.5 overflow-hidden rounded-pill bg-overlay">
        <div
          className={`h-full rounded-pill ${full ? 'bg-wrong' : 'bg-pen'}`}
          style={{ width: `${(shown / limit) * 100}%` }}
        />
      </div>
      {resets && (
        <p className="mt-2 text-sm text-dim">
          Resets <LocalTime iso={resets} dateOnly={dateOnly} />
        </p>
      )}
    </li>
  )
}
