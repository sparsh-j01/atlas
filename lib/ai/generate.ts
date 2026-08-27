import 'server-only'

import { geminiGenerate, geminiModel } from './gemini'

// The provider seam for AI generation (M6). Every module in lib/ai talks to the types
// here and never to a vendor SDK or endpoint — swapping providers is one new file plus
// a branch in `createGenerateClient` below, nothing else moves.
//
// The contract is deliberately narrow because generation here is structured output:
// ONE system prompt + a user message, forced into exactly ONE tool call whose arguments
// are the answer. No streaming, no multi-turn, no free text — both phases of generation
// (blueprint, slide) fit that shape, and it keeps every provider implementation ~100 lines.

/** JSON Schema describing the tool's arguments. Providers pass it through as-is
 *  (Gemini calls this `parameters`; Anthropic `input_schema`). */
export type ToolSpec = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export type GenerateMessage = { role: 'user'; content: string }

export type GenerateArgs = {
  /** Shared instructions. Kept byte-identical across all calls in a run so provider-side
   *  prefix caching (Gemini implicit caching) can hit on every call after the first. */
  system: string
  messages: GenerateMessage[]
  /** The single tool the model must call; its arguments ARE the generated payload. */
  tool: ToolSpec
  /** Cost cap per call — set by the orchestrator so one runaway slide can't burn budget. */
  maxOutputTokens?: number
  /** Absolute epoch-ms stop for this call and any internal retry. The orchestrator runs
   *  under a serverless duration cap, so time is a shared budget, not a per-call one:
   *  implementations must clamp their own timeout to what's left and fail rather than
   *  start a call they can't finish. */
  deadline?: number
  /** Abort signal for cancellation */
  signal?: AbortSignal
}

export type GenerateResult =
  | { ok: true; input: unknown }
  | { ok: false; error: string }

/**
 * One forced tool call. Implementations must:
 * - force the named tool (no free-text path),
 * - return `{ ok: false }` rather than throw when the model answers without the tool,
 *   gets truncated, or is blocked — the caller owns retry policy,
 * - retry transient transport failures (429 / 5xx / network) once internally.
 */
export type GenerateFn = (args: GenerateArgs) => Promise<GenerateResult>

export const GENERATION_PROVIDERS = ['gemini'] as const
export type GenerationProvider = (typeof GENERATION_PROVIDERS)[number]

function currentProvider(): GenerationProvider {
  const raw = process.env.AI_PROVIDER?.trim().toLowerCase() || 'gemini'
  if (!(GENERATION_PROVIDERS as readonly string[]).includes(raw))
    throw new Error(`Unknown AI_PROVIDER "${raw}" — expected one of ${GENERATION_PROVIDERS.join(', ')}.`)
  return raw as GenerationProvider
}

/** Pick the configured provider. Falls back to Gemini when unset. Adding a provider:
 *  implement `GenerateFn` in its own file, add it to GENERATION_PROVIDERS, add a branch
 *  here. Nothing else in the app names a vendor. */
export function createGenerateClient(): GenerateFn {
  switch (currentProvider()) {
    case 'gemini':
      return geminiGenerate()
  }
}

/**
 * The provider and model a `createGenerateClient()` call would resolve to, right now.
 *
 * Read this rather than writing a model name into a report. The eval artifact previously
 * carried a `PINNED_MODEL` constant that nothing verified: the file said one model, the
 * published run said another, and `.env.example` documented a third. A number is only
 * interpretable against the model that produced it, so the model has to come from the same
 * place the request does.
 */
export function generationConfig(): { provider: GenerationProvider; model: string } {
  const provider = currentProvider()
  switch (provider) {
    case 'gemini':
      return { provider, model: geminiModel() }
  }
}
