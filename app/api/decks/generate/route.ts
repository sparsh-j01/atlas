import { NextResponse } from 'next/server'
import { and, eq, gt, sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import { decks, slides as slidesTable } from '@/lib/db/schema'
import { getAuthUser } from '@/lib/auth'
import { validateSlide, toStoredSlide, type EditableSlide } from '@/lib/slides'
import {
  GEN_LIMITS,
  BLUEPRINT_TOOL,
  buildBlueprintMessages,
  isDifficulty,
  isSlideCount,
  parseBlueprint,
  type BlueprintSlide,
} from '@/lib/ai/blueprint'
import { SLIDE_TOOL, buildSlideMessages, generatedToEditable } from '@/lib/ai/slide'
import { finalizeSlides, GEN_MAX_ATTEMPTS } from '@/lib/ai/validate'
import { createGenerateClient } from '@/lib/ai/generate'
import { SYSTEM_PROMPT } from '@/lib/ai/prompt'
import { logger } from '@/lib/logger'

// Topic → full draft deck (M6). The orchestrator for the two-phase generation described
// in docs/architecture.md flow A: blueprint once, then every slide in parallel, validate,
// persist a DRAFT deck and hand the deckId back — the creator reviews in the existing
// editor before anything can go live (the ready-gate re-validates every slide).

// Vercel serverless duration cap for this route. The two phases do NOT fit inside it by
// construction — 20 slides at 5-way concurrency is 4 waves, and a wave that retries can
// take a minute on its own. So time is an explicit budget threaded down to every provider
// call (GenerateArgs.deadline): calls that can't finish in what's left aren't started, the
// entry is dropped, and finalizeSlides decides whether enough survived. Running out of
// time therefore fails loudly with a real message instead of the platform killing the
// request and throwing away every slide that did generate.
// ponytail: one request, one budget. The job model (jobId + poll) on the plan's M6
// checklist is the upgrade path when 20-slide decks routinely hit the floor.
export const maxDuration = 60
const TIME_BUDGET_MS = 52_000 // headroom under maxDuration for auth, DB and the response

const GENERATIONS_PER_HOUR = 10 // per-creator guardrail; enforced against real shared state (the decks table)
const BLUEPRINT_MAX_TOKENS = 1_500 // cost cap per call — an outline is short by construction
const SLIDE_MAX_TOKENS = 1_000 // one question + options + explanation is ~300 tokens worst case
// Free-tier RPM is the binding constraint on burst size: wider waves just collect 429s.
const SLIDE_CONCURRENCY = 5

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

/** mapWithConcurrency: run `fn` over `items` at most `limit` at a time, preserving order. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

export async function POST(req: Request) {
  const deadline = Date.now() + TIME_BUDGET_MS
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to generate a deck.')
  // Narrowed id for the closures below — TS won't carry the null-check into them.
  const ownerId = user.id

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return bad(400, 'Expected a JSON body.')
  }
  const b = (body ?? {}) as Record<string, unknown>

  const topic = typeof b.topic === 'string' ? b.topic.trim() : ''
  if (!(topic.length >= GEN_LIMITS.topicMinChars && topic.length <= GEN_LIMITS.topicMaxChars))
    return bad(
      400,
      `Topic must be ${GEN_LIMITS.topicMinChars} to ${GEN_LIMITS.topicMaxChars} characters.`,
    )
  const rawSlideCount = b.slideCount === undefined ? 8 : b.slideCount
  if (!isSlideCount(rawSlideCount))
    return bad(400, `Slide count must be ${GEN_LIMITS.minSlides} to ${GEN_LIMITS.maxSlides}.`)
  const slideCount: number = rawSlideCount
  const rawDifficulty = b.difficulty === undefined ? 'medium' : b.difficulty
  if (!isDifficulty(rawDifficulty)) return bad(400, 'Difficulty must be easy, medium or hard.')
  const includePolls = b.includePolls === undefined ? true : b.includePolls === true

  // --- Reserve the rate-limit slot BEFORE any provider call -------------------
  //
  // The cap counts decks created in the last hour, and the reservation IS a deck row:
  // inserting it first means the COUNT below sees in-flight runs, so overlapping
  // requests each consume a slot. Counting only completions was the /cso finding
  // (2026-08-22): every request passed while generation ran, because the row that
  // backs the counter didn't exist yet.
  // ponytail: two truly simultaneous requests can still both pass on the same count
  // (single-INSERT race window, milliseconds). Ceiling: a burst overshoots the hourly
  // cap by the burst size. Upgrade path when that matters: a per-(owner, window)
  // counter row with a conditional increment, which is atomic without a lock.

  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(decks)
    .where(
      and(eq(decks.ownerId, ownerId), eq(decks.sourceType, 'topic'), gt(decks.createdAt, hourAgo)),
    )
  if (n >= GENERATIONS_PER_HOUR)
    return bad(429, `Generation limit reached (${GENERATIONS_PER_HOUR}/hour). Try again later.`)

  const [reserved] = await db
    .insert(decks)
    .values({
      ownerId,
      title: '', // replaced from the blueprint on success
      status: 'draft',
      sourceType: 'topic',
      sourceRef: topic,
    })
    .returning({ id: decks.id })

  // Every exit after this point owes the user either a finished deck or a deleted
  // reservation — an abandoned '' titled deck would sit on their dashboard forever.
  async function releaseReservation(): Promise<void> {
    await db.delete(decks).where(and(eq(decks.id, reserved.id), eq(decks.ownerId, ownerId)))
  }

  // --- Phase 1: blueprint (one bounded retry) ---------------------------------

  const client = createGenerateClient()
  const blueprintOpts = { topic, slideCount, difficulty: rawDifficulty, includePolls }

  // The survival floor, shared by both phases: below this the deck isn't worth showing.
  // finalizeSlides derives the same number from slideCount — kept here to gate the outline.
  const floor = Math.max(GEN_LIMITS.minSlides, Math.ceil(slideCount / 2))

  async function requestBlueprint(minEntries: number) {
    const res = await client({
      system: SYSTEM_PROMPT,
      messages: buildBlueprintMessages(blueprintOpts),
      tool: BLUEPRINT_TOOL,
      maxOutputTokens: BLUEPRINT_MAX_TOKENS,
      deadline,
    })
    if (!res.ok) return res
    const parsed = parseBlueprint(res.input)
    if (!parsed.ok) return { ok: false as const, error: parsed.errors.join(' ') }

    if (parsed.value.slides.length < minEntries)
      return {
        ok: false as const,
        error: `blueprint proposed ${parsed.value.slides.length} slides, need at least ${minEntries}`,
      }
    return { ok: true as const, value: parsed.value }
  }

  // Ask for exactly what the creator requested; accept a short outline only on the retry,
  // and only down to the floor. The two gates have to differ — an outline admitted at the
  // floor leaves phase 2 zero room to drop a single bad slide without failing the run.
  let blueprint = await requestBlueprint(slideCount)
  if (!blueprint.ok) blueprint = await requestBlueprint(floor)
  if (!blueprint.ok) {
    await releaseReservation()
    logger.error('blueprint phase failed', { ownerId: user.id, reason: blueprint.error })
    return bad(502, 'Could not produce a valid deck outline. Try again.')
  }

  // --- Phase 2: slides in parallel (bounded), each with a bounded retry --------

  // The creator's difficulty, NOT the blueprint's echo of it: `difficulty` is optional in
  // the tool schema, so a model that simply omits it gets defaulted to 'medium' by
  // parseBlueprint — which would silently generate a "hard" deck at medium.
  const ctx = { topic, difficulty: rawDifficulty }

  async function generateEntry(entry: BlueprintSlide): Promise<EditableSlide | null> {
    for (let attempt = 0; attempt < GEN_MAX_ATTEMPTS; attempt++) {
      const res = await client({
        system: SYSTEM_PROMPT,
        messages: buildSlideMessages(ctx, entry),
        tool: SLIDE_TOOL,
        maxOutputTokens: SLIDE_MAX_TOKENS,
        deadline,
      })
      if (!res.ok) continue
      const draft = generatedToEditable(res.input, entry)
      if (!draft || validateSlide(draft).length > 0) continue // regenerate invalid output
      return draft
    }
    return null // dropped — finalizeSlides decides whether enough survived
  }

  let finalized: Awaited<ReturnType<typeof finalizeSlides>>
  try {
    // Trust the request over the model on count. parseBlueprint only bounds the array
    // globally (3–20), so "give me 3 slides" answered with 20 entries would otherwise mean
    // 20 provider calls and a 20-slide deck nobody asked for.
    const entries = blueprint.value.slides.slice(0, slideCount)
    const produced = await mapPool(
      entries.map((entry) => ({ entry, subtopic: entry.subtopic })),
      SLIDE_CONCURRENCY,
      async ({ entry, subtopic }) => ({ subtopic, slide: await generateEntry(entry) }),
    )
    // slideCount, NOT produced.length: the floor is a fraction of what the CREATOR asked
    // for. Measuring it against the outline's own length halves it twice — a 20-slide
    // request could ship 5 slides and still report success.
    finalized = finalizeSlides(produced, slideCount)
  } catch {
    await releaseReservation()
    return bad(502, 'Generation failed unexpectedly. Try again.')
  }
  if (!finalized.ok) {
    await releaseReservation()
    return bad(502, `Generation failed validation. ${finalized.errors.join(' ')}`)
  }

  // --- Persist: fill the reserved draft deck, then straight into the editor ----

  await db.transaction(async (tx) => {
    await tx
      .update(decks)
      .set({
        title: blueprint.value.title,
        description: blueprint.value.description ?? null,
        updatedAt: new Date(),
      })
      .where(and(eq(decks.id, reserved.id), eq(decks.ownerId, ownerId)))

    await tx.insert(slidesTable).values(
      finalized.slides.map((draft, position) => {
        const stored = toStoredSlide(draft)
        return {
          deckId: reserved.id,
          position,
          type: draft.type,
          prompt: stored.prompt,
          config: stored.config,
        }
      }),
    )
  })

  return NextResponse.json({
    deckId: reserved.id,
    title: blueprint.value.title,
    slides: finalized.slides.length,
    dropped: finalized.dropped,
  })
}
