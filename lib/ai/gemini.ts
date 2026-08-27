import 'server-only'

import { serverEnv } from '@/lib/env.server'
import { logger } from '@/lib/logger'
import type { GenerateArgs, GenerateFn, GenerateResult } from './generate'

// Gemini implementation of the generation seam (lib/ai/generate.ts). Plain fetch — no SDK,
// matching how the rest of this repo talks to vendors (Supabase REST broadcast, etc.).
//
// Structured output = forced function calling: `toolConfig.mode: "ANY"` + the single
// allowed name, so a successful response's `functionCall.args` IS the generated payload.
// The system prompt is sent byte-identical across every call in a run so Gemini's implicit
// prefix caching can serve calls after the first at reduced cost/latency.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
// Override with GEMINI_MODEL. Free-tier quota is per model per day
// (GenerateRequestsPerDayPerProjectPerModel-FreeTier), so a model whose bucket is spent
// returns 429 while another still answers — measured 2026-08-24: gemini-3.5-flash capped at
// 20 requests/day, gemini-3.7-flash still serving. Do not treat this default as a budget.
const MODEL_DEFAULT = 'gemini-3.7-flash'
const CALL_TIMEOUT_MS = 30_000 // per call ceiling; `args.deadline` can shrink it further
const MIN_CALL_MS = 3_000 // below this there's no point starting a call — fail fast instead
const RETRY_DELAY_MS = 1_000
// Transient = worth one quiet retry before failing: rate limit or provider-side hiccup.
// Anything else (400/403/etc.) is a config or request problem and fails immediately.
const TRANSIENT_STATUS = new Set([429, 500, 502, 503])

type Part = { text?: string; functionCall?: { name: string; args?: unknown } }
type GeminiResponse = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
}

/** The model this provider will ACTUALLY call, after the env override. Exported because a
 *  benchmark that hardcodes its own model string is recording a wish, not a measurement —
 *  the eval artifact must name the model the request went to. */
export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || MODEL_DEFAULT
}

export function geminiGenerate(): GenerateFn {
  const model = geminiModel()

  return async (args: GenerateArgs): Promise<GenerateResult> => {
    const body = {
      systemInstruction: { parts: [{ text: args.system }] },
      contents: args.messages.map((m) => ({ role: 'user', parts: [{ text: m.content }] })),
      tools: [
        {
          functionDeclarations: [
            {
              name: args.tool.name,
              description: args.tool.description,
              parameters: args.tool.inputSchema,
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [args.tool.name] },
      },
      generationConfig: {
        // Thinking is ON by default on 2.5 models and its tokens count against
        // maxOutputTokens — leaving it on means the caps below get spent reasoning and the
        // call returns finishReason MAX_TOKENS with no functionCall at all. Both phases are
        // structured extraction, so there is nothing to think about. 2.5 Flash accepts 0;
        // 2.5 Pro does not (min 128) — a Pro swap has to raise the caps instead.
        thinkingConfig: { thinkingBudget: 0 },
        ...(args.maxOutputTokens ? { maxOutputTokens: args.maxOutputTokens } : {}),
      },
    }

    // Absolute wall-clock stop for this call INCLUDING its retry, so the orchestrating
    // route can hand out what's left of its own budget and never overshoot maxDuration.
    const deadline = args.deadline ?? Date.now() + 2 * CALL_TIMEOUT_MS
    const budget = () => Math.min(CALL_TIMEOUT_MS, deadline - Date.now())

    async function attempt(): Promise<{ response?: Response; error?: string; transient?: boolean }> {
      const ms = budget()
      if (ms < MIN_CALL_MS) return { error: 'out of time budget', transient: false }
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), ms)
        
        // Combine external signal with our timeout
        if (args.signal) {
          if (args.signal.aborted) {
            clearTimeout(timeoutId)
            return { error: 'aborted', transient: false }
          }
          args.signal.addEventListener('abort', () => controller.abort())
        }
        
        const response = await fetch(`${API_BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': serverEnv.geminiKey },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timeoutId)
        if (response.ok) return { response }
        // The upstream body is diagnostic-only and never leaves the server. Google's 429
        // text names the provider, the exact model id, the billing tier and the numeric
        // rate limit; two routes interpolate this error straight into a 502 they return to
        // the browser, so anything put in the string here is published. Log it, return the
        // status alone (the retry path below matches on '429', so it has to stay).
        const snippet = (await response.text().catch(() => '')).slice(0, 300)
        logger.error('gemini call failed', { model, status: response.status, upstream: snippet })
        return {
          error: `provider returned ${response.status}`,
          transient: TRANSIENT_STATUS.has(response.status),
        }
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') {
          return { error: 'aborted', transient: false }
        }
        logger.error('gemini request threw', { model, cause: String(e) })
        return { error: 'generation request failed', transient: true }
      }
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    const first = await attempt()
    if (first.response) return parseResponse(first.response)
    if (!first.transient) return { ok: false, error: first.error! }
    const delay = first.error?.includes('429') ? 15_000 : RETRY_DELAY_MS
    if (budget() - delay < MIN_CALL_MS)
      return { ok: false, error: `${first.error} (no time budget left to retry)` }
    await sleep(delay)
    const second = await attempt()
    if (second.response) return parseResponse(second.response)
    return { ok: false, error: second.error ?? first.error ?? 'generation failed twice' }
  }
}

/** A 200 body into the seam's result. Model-level failures (blocked, truncated, answered
 *  without the tool) are NOT retried — they're deterministic enough that a blind retry
 *  wastes budget; the orchestrator decides whether regeneration is worth a full call. */
async function parseResponse(res: Response): Promise<GenerateResult> {
  let data: GeminiResponse
  try {
    data = (await res.json()) as GeminiResponse
  } catch {
    return { ok: false, error: 'provider returned an unreadable body' }
  }

  const blocked = data.promptFeedback?.blockReason
  if (blocked) return { ok: false, error: `prompt blocked (${blocked})` }

  const candidate = data.candidates?.[0]
  if (!candidate) return { ok: false, error: 'provider returned no candidates' }
  if (candidate.finishReason === 'MAX_TOKENS')
    return { ok: false, error: 'output truncated by the token cap' }
  if (candidate.finishReason && candidate.finishReason !== 'STOP')
    return { ok: false, error: `generation stopped early (${candidate.finishReason})` }

  const call = candidate.content?.parts?.find((p) => p.functionCall)?.functionCall
  if (!call) return { ok: false, error: 'model answered without the required tool call' }
  return { ok: true, input: call.args ?? {} }
}
