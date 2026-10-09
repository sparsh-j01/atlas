import { NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { decks, slides as slidesTable } from '@/lib/db/schema'
import { getAuthUser } from '@/lib/auth'
import { validateSlide, toStoredSlide } from '@/lib/slides'
import {
  GEN_LIMITS,
  BLUEPRINT_TOOL,
  buildBlueprintMessages,
  isDifficulty,
  isSlideCount,
  parseBlueprint,
  spareSlots,
  type BlueprintSlide,
} from '@/lib/ai/blueprint'
import { fillPool } from '@/lib/ai/pool'
import { SLIDE_TOOL, buildSlideMessages, generatedToEditable } from '@/lib/ai/slide'
import { finalizeSlides, GEN_MAX_ATTEMPTS, type ProducedSlide } from '@/lib/ai/validate'
import { createGenerateClient } from '@/lib/ai/generate'
import { SYSTEM_PROMPT } from '@/lib/ai/prompt'
import { logger } from '@/lib/logger'
import { checkLimit, tooMany } from '@/lib/rate-limit'
import { refuse, startAiDeck } from '@/lib/usage'

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

const BLUEPRINT_MAX_TOKENS = 1_500 // cost cap per call — an outline is short by construction
const SLIDE_MAX_TOKENS = 1_000 // one question + options + explanation is ~300 tokens worst case
// Free-tier RPM is the binding constraint on burst size: wider waves just collect 429s.
const SLIDE_CONCURRENCY = 5

function bad(status: number, error: string) {
  return NextResponse.json({ error }, { status })
}

export async function POST(req: Request) {
  const deadline = Date.now() + TIME_BUDGET_MS
  const user = await getAuthUser()
  if (!user) return bad(401, 'Sign in to generate a deck.')
  // Narrowed id for the closures below — TS won't carry the null-check into them.
  const ownerId = user.id
  // Burst ceiling first: cheap, atomic, and counted even for a request that fails validation.
  const burst = await checkLimit('aiPerUser', ownerId)
  if (!burst.ok) return tooMany(burst.retryAfterSec)

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

  // --- Budget and quota BEFORE any provider call ------------------------------
  //
  // startAiDeck checks the global AI budget and this creator's daily/monthly quota, then
  // records the run in `ai_usage` so overlapping requests each see it. It replaced an hourly
  // count of `decks` rows — which deleting a deck reset, so generate, delete, repeat was
  // unmetered. `ai_usage` rows outlive the deck.
  const refusal = await startAiDeck(ownerId, 'topic')
  if (refusal) return refuse(refusal)

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
  // The outline carries spares past slideCount; generation reaches for one only when a slide
  // fails, so the teacher still gets the count they asked for.
  const spares = spareSlots(slideCount)
  const blueprintOpts = { topic, slideCount: slideCount + spares, difficulty: rawDifficulty }

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

  async function generateEntry(entry: BlueprintSlide): Promise<ProducedSlide> {
    let reason = 'the AI wrote an invalid question'
    for (let attempt = 0; attempt < GEN_MAX_ATTEMPTS; attempt++) {
      const res = await client({
        system: SYSTEM_PROMPT,
        messages: buildSlideMessages(ctx, entry),
        tool: SLIDE_TOOL,
        maxOutputTokens: SLIDE_MAX_TOKENS,
        deadline,
      })
      if (!res.ok) {
        reason = res.budget ? 'the AI spending limit was reached' : 'the AI service failed or timed out'
        continue
      }
      const draft = generatedToEditable(res.input)
      if (!draft || validateSlide(draft).length > 0) continue // regenerate invalid output
      return { subtopic: entry.subtopic, slide: draft }
    }
    // Dropped — a spare takes its place if there is one; finalizeSlides decides whether
    // enough survived.
    return { subtopic: entry.subtopic, slide: null, reason }
  }

  let finalized: Awaited<ReturnType<typeof finalizeSlides>>
  try {
    // Trust the request over the model on count. parseBlueprint only bounds the array
    // globally, so "give me 3 slides" answered with 20 entries would otherwise mean 20
    // provider calls; fillPool stops starting entries once slideCount have succeeded.
    const entries = blueprint.value.slides.slice(0, slideCount + spares)
    const produced = await fillPool(entries, slideCount, SLIDE_CONCURRENCY, generateEntry, (p) => p.slide !== null)
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

  // One transaction, so a failure writes nothing — but the reserved row was committed before
  // generation started and must go too, or it stays as an empty untitled draft.
  try {
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
  } catch (error) {
    await releaseReservation()
    logger.error('deck save failed', {
      ownerId,
      reason: error instanceof Error ? error.message : String(error),
    })
    return bad(500, 'Could not save the deck. Try again.')
  }

  return NextResponse.json({
    deckId: reserved.id,
    title: blueprint.value.title,
    slides: finalized.slides.length,
    dropped: finalized.dropped,
  })
}
