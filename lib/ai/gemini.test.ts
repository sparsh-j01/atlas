import { afterEach, describe, expect, it, vi } from 'vitest'

// gemini.ts is server-only and reads the API key from serverEnv; both are stubbed so the
// provider's request shape and its time budgeting stay unit-testable with no network.
vi.mock('server-only', () => ({}))
vi.mock('@/lib/env.server', () => ({ serverEnv: { geminiKey: 'test-key' } }))

const { geminiGenerate } = await import('./gemini')

const TOOL = { name: 'emit_slide', description: 'd', inputSchema: { type: 'object' } }
const args = { system: 'sys', messages: [{ role: 'user' as const, content: 'hi' }], tool: TOOL }

/** Replaces fetch and records what the provider actually put on the wire. */
function stubFetch(body: unknown, status = 200) {
  const sent: RequestInit[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (...call: [string, RequestInit]) => {
      sent.push(call[1])
      return new Response(JSON.stringify(body), { status })
    }),
  )
  return sent
}

/** The JSON body of the nth request sent. */
const sentBody = (sent: RequestInit[], n = 0) => JSON.parse(sent[n].body as string)
const withCall = (a: unknown) => ({
  candidates: [{ content: { parts: [{ functionCall: { name: 'emit_slide', args: a } }] }, finishReason: 'STOP' }],
})

afterEach(() => vi.unstubAllGlobals())

describe('geminiGenerate request shape', () => {
  it('disables thinking — its tokens would otherwise eat maxOutputTokens before the tool call', async () => {
    const f = stubFetch(withCall({ prompt: 'q' }))
    await geminiGenerate()({ ...args, maxOutputTokens: 1000 })
    const sent = sentBody(f)
    expect(sent.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
    expect(sent.generationConfig.maxOutputTokens).toBe(1000)
  })

  it('sends thinkingConfig even with no token cap', async () => {
    const f = stubFetch(withCall({}))
    await geminiGenerate()(args)
    const sent = sentBody(f)
    expect(sent.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 })
    expect(sent.generationConfig.maxOutputTokens).toBeUndefined()
  })

  it('forces the single named tool', async () => {
    const f = stubFetch(withCall({}))
    await geminiGenerate()(args)
    const sent = sentBody(f)
    expect(sent.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY', allowedFunctionNames: ['emit_slide'] })
  })
})

describe('time budget', () => {
  it('never starts a call it cannot finish', async () => {
    const f = stubFetch(withCall({}))
    const res = await geminiGenerate()({ ...args, deadline: Date.now() + 100 })
    expect(res).toEqual({ ok: false, error: 'out of time budget' })
    expect(f).toHaveLength(0)
  })

  it('skips the transient retry when the budget is spent', async () => {
    const f = stubFetch({ error: 'slow down' }, 429)
    const res = await geminiGenerate()({ ...args, deadline: Date.now() + 3_500 })
    expect(res.ok).toBe(false)
    expect(f).toHaveLength(1) // would be 2 with budget left
  })
})

describe('response parsing', () => {
  it('returns the tool arguments on success', async () => {
    stubFetch(withCall({ prompt: 'q' }))
    expect(await geminiGenerate()(args)).toEqual({ ok: true, input: { prompt: 'q' } })
  })

  it('reports truncation rather than shipping a partial slide', async () => {
    stubFetch({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] })
    const res = await geminiGenerate()(args)
    expect(res).toEqual({ ok: false, error: 'output truncated by the token cap' })
  })

  it('fails when the model answers without the tool', async () => {
    stubFetch({ candidates: [{ content: { parts: [{ text: 'sure!' }] }, finishReason: 'STOP' }] })
    const res = await geminiGenerate()(args)
    expect(res.ok).toBe(false)
  })
})

describe('upstream error bodies stay server-side', () => {
  // Two routes interpolate this error into a 502 they return to the browser, so whatever
  // ends up in `error` is published to any signed-in creator. Google's real 429 text names
  // the provider, the model id, the billing tier and the numeric rate limit.
  const QUOTA_BODY = {
    error: {
      message:
        'Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, ' +
        'limit: 20, model: gemini-3.5-flash',
    },
  }

  it('reports the status without the provider body', async () => {
    stubFetch(QUOTA_BODY, 429)
    const res = await geminiGenerate()({ ...args, deadline: Date.now() + 3_500 })
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.error).toBe('provider returned 429 (no time budget left to retry)')
  })

  it('leaks no quota, model or tier detail on any upstream status', async () => {
    for (const status of [400, 403, 429, 500]) {
      stubFetch(QUOTA_BODY, status)
      const res = await geminiGenerate()({ ...args, deadline: Date.now() + 3_500 })
      const error = res.ok ? '' : res.error
      expect(error).not.toMatch(/quota|limit|free_tier|gemini-|googleapis/i)
    }
  })
})
