import 'server-only'

import { serverEnv } from '@/lib/env.server'
import { logger } from '@/lib/logger'
import { reserveAiCall, settleAiCall, inputTokenCeiling, type Reservation } from './budget'
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
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number }
}

/** The model this provider will ACTUALLY call, after the env override. Exported because a
 *  benchmark that hardcodes its own model string is recording a wish, not a measurement —
 *  the eval artifact must name the model the request went to. */
export function geminiModel(): string {
  return process.env.GEMINI_MODEL?.trim() || MODEL_DEFAULT
}

/** `modelOverride` is for a caller with its own model choice (OCR runs on Flash-Lite, see
 *  lib/ingest/ocr.ts → ocrModel); generation uses GEMINI_MODEL. */
export function geminiGenerate(modelOverride?: string): GenerateFn {
  const model = modelOverride ?? geminiModel()

  return async (args: GenerateArgs): Promise<GenerateResult> => {
    const maxOutputTokens = args.maxOutputTokens ?? 8192
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65536)
      return { ok: false, error: 'Invalid output token limit' }
    const images = args.images ?? []
    if (!images.every((img) => Number.isSafeInteger(img.tokenCeiling) && img.tokenCeiling > 0))
      return { ok: false, error: 'Invalid image token ceiling' }
    const imageParts = images.map((img) => ({ inlineData: { mimeType: img.mimeType, data: Buffer.from(img.data).toString('base64') } }))
    const body = {
      systemInstruction: { parts: [{ text: args.system }] },
      contents: args.messages.map((m, i) => ({
        role: 'user',
        parts: [
          { text: m.content },
          ...(i === args.messages.length - 1 ? imageParts : []),
        ],
      })),
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
        // Flash-Lite (OCR) answers 400 "invalid argument" to thinkingBudget 0 and takes the
        // Gemini 3 thinkingLevel instead (probed 2026-10-05; 3.7 Flash accepts either).
        thinkingConfig: model.includes('flash-lite') ? { thinkingLevel: 'minimal' } : { thinkingBudget: 0 },
        maxOutputTokens,
      },
    }

    // Absolute wall-clock stop for this call INCLUDING its retry, so the orchestrating
    // route can hand out what's left of its own budget and never overshoot maxDuration.
    const deadline = args.deadline ?? Date.now() + 2 * CALL_TIMEOUT_MS
    const budget = () => Math.min(CALL_TIMEOUT_MS, deadline - Date.now())

    const serialized = JSON.stringify(body)
    // Text by its bytes (inputTokenCeiling), images by their own ceilings. Counting the base64
    // as tokens reserved ~450x the real cost: a 5-slide batch held ~2.5M tokens against a
    // measured ~5.5k, enough to trip the monthly cap on two concurrent batches.
    const inputCeiling = images.length === 0
      ? inputTokenCeiling(serialized)
      : inputTokenCeiling(JSON.stringify({ ...body, contents: args.messages.map((m) => ({ role: 'user', parts: [{ text: m.content }] })) }))
        + images.reduce((sum, img) => sum + img.tokenCeiling, 0)
    async function attempt(): Promise<{ result?: GenerateResult; error?: string; transient?: boolean; budget?: true }> {
      if (budget() < MIN_CALL_MS) return { error: 'out of time budget', transient: false }
      if (args.signal?.aborted) return { error: 'aborted', transient: false }
      let reservation: Reservation
      try {
        reservation = await reserveAiCall('model', model, inputCeiling, maxOutputTokens)
      } catch {
        return { error: 'AI spending is paused. Try again later.', transient: false, budget: true }
      }
      // The budget lock may have waited. A call not sent can safely refund its reservation.
      if (budget() < MIN_CALL_MS || args.signal?.aborted) {
        await settleAiCall(reservation, 0, 0)
        return { error: 'out of time budget', transient: false }
      }
      const controller = new AbortController()
      const abort = () => controller.abort()
      const timeoutId = setTimeout(abort, budget())
      args.signal?.addEventListener('abort', abort, { once: true })
      try {
        const response = await fetch(`${API_BASE}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': serverEnv.geminiKey },
          body: serialized,
          signal: controller.signal,
        })
        if (response.ok) return { result: await parseResponse(response, reservation) }
        // An error status is a definite outcome, not an uncertain one: Gemini bills the tokens a
        // successful response reports in usageMetadata, and a refusal reports none. Release
        // the reservation; keeping it charged every 429 (routine on the free tier) at the
        // worst-case price. Never log the upstream body.
        await response.body?.cancel()
        await settleAiCall(reservation, 0, 0)
        logger.error('gemini call failed', { model, status: response.status })
        return { error: `provider returned ${response.status}`, transient: TRANSIENT_STATUS.has(response.status) }
      } catch (error) {
        if (controller.signal.aborted) return { error: 'aborted', transient: false }
        logger.error('gemini request threw', { model, error })
        return { error: 'generation request failed', transient: true }
      } finally {
        // Covers response-body parsing too. Abort and error paths always release timers/listeners.
        clearTimeout(timeoutId)
        args.signal?.removeEventListener('abort', abort)
      }
    }

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    const first = await attempt()
    if (first.result) return first.result
    if (!first.transient) return { ok: false, error: first.error!, ...(first.budget ? { budget: true as const } : {}) }
    const delay = first.error?.includes('429') ? 15_000 : RETRY_DELAY_MS
    if (budget() - delay < MIN_CALL_MS)
      return { ok: false, error: `${first.error} (no time budget left to retry)` }
    await sleep(delay)
    const second = await attempt()
    if (second.result) return second.result
    return { ok: false, error: second.error ?? first.error ?? 'generation failed twice', ...(second.budget ? { budget: true as const } : {}) }
  }
}

/** A 200 body into the seam's result. Model-level failures (blocked, truncated, answered
 *  without the tool) are NOT retried — they're deterministic enough that a blind retry
 *  wastes budget; the orchestrator decides whether regeneration is worth a full call. */
async function parseResponse(res: Response, reservation: Reservation): Promise<GenerateResult> {
  let data: GeminiResponse
  try {
    data = (await res.json()) as GeminiResponse
  } catch {
    return { ok: false, error: 'provider returned an unreadable body' }
  }

  // Recorded before any of the checks below: a blocked, truncated or tool-less answer is
  // billed exactly like a good one. Thinking tokens are billed at the output rate.
  const usage = data.usageMetadata
  if (usage && Number.isSafeInteger(usage.promptTokenCount) && Number.isSafeInteger(usage.candidatesTokenCount)) {
    await settleAiCall(reservation, usage.promptTokenCount!, usage.candidatesTokenCount! + (usage.thoughtsTokenCount ?? 0))
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
