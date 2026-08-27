import 'server-only'
import { serverEnv } from '@/lib/env.server'

// Embedding seam for the RAG path (M7 phase 5). Same shape as the generation seam in
// lib/ai/generate.ts: one narrow function, no vendor SDK, swap = one file.
//
// Two things here are load-bearing and easy to get subtly wrong:
//
// 1. DIMENSION. pgvector fixes the width at the column, so EMBEDDING_DIMENSION and
//    `embeddings.vector` in lib/db/schema.ts must agree exactly. They didn't (768 vs 384)
//    and every insert failed, which is why no document ever reached `ready`.
//
// 2. TASK TYPE. Gemini embeds asymmetrically: a passage being indexed and a question being
//    asked go through different projections. Embedding a query as RETRIEVAL_DOCUMENT
//    silently degrades recall — nothing errors, the neighbours are just worse. This is the
//    single cheapest retrieval-quality win in the pipeline, so the task type is a required
//    argument rather than a defaulted one.

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'
// text-embedding-004 was the original default and is now RETIRED: the API answers
// 404 "not found for API version v1beta, or is not supported for embedContent".
// gemini-embedding-001 is the GA replacement. It emits 3072 dimensions by default, so
// outputDimensionality is REQUIRED here, not an optimisation — pgvector fixes
// `embeddings.vector` at 768 and a 3072-wide insert is rejected by the column.
const MODEL_DEFAULT = 'gemini-embedding-001'
export const EMBEDDING_DIMENSION = 768 // must equal embeddings.vector width in schema.ts
// Gemini caps a batchEmbedContents call at 100 requests.
const MAX_BATCH = 100

/** Indexing a passage vs. asking a question — see note 2 above. */
export type EmbedTask = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

function model(): string {
  return process.env.EMBEDDING_MODEL?.trim() || MODEL_DEFAULT
}

/** Provenance stamped onto every row so two populations are never compared, and a model
 *  change can be detected and re-embedded rather than silently mixed. */
export function embeddingConfig() {
  return {
    provider: 'gemini',
    model: model(),
    version: process.env.EMBEDDING_VERSION?.trim() || '001',
    dimension: EMBEDDING_DIMENSION,
  }
}

async function call(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${API_BASE}/${model()}:${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': serverEnv.geminiKey },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const snippet = (await res.text().catch(() => '')).slice(0, 300)
    throw new Error(`embedding failed: ${res.status} ${snippet}`)
  }
  return res.json()
}

function assertWidth(values: unknown): number[] {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSION)
    throw new Error(
      `embedder returned ${Array.isArray(values) ? values.length : 'no'} dimensions, expected ${EMBEDDING_DIMENSION}`,
    )
  return values as number[]
}

/** One text to one vector. */
export async function embed(text: string, task: EmbedTask): Promise<number[]> {
  const data = (await call('embedContent', {
    content: { parts: [{ text }] },
    taskType: task,
    outputDimensionality: EMBEDDING_DIMENSION,
  })) as { embedding?: { values?: unknown } }
  return assertWidth(data.embedding?.values)
}

/**
 * Many texts to many vectors, in provider-side batches.
 *
 * Ingestion embeds every chunk of a document; one HTTP round-trip per chunk turned a
 * 300-chunk PDF into 300 serial requests, which is both slow and the fastest way to meet
 * the free tier's rate limit. Order is preserved so callers can zip the result against
 * their input.
 */
export async function embedBatch(texts: string[], task: EmbedTask): Promise<number[][]> {
  const out: number[][] = []
  const m = `models/${model()}`
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const slice = texts.slice(i, i + MAX_BATCH)
    const data = (await call('batchEmbedContents', {
      requests: slice.map((text) => ({
        model: m,
        content: { parts: [{ text }] },
        taskType: task,
        outputDimensionality: EMBEDDING_DIMENSION,
      })),
    })) as { embeddings?: { values?: unknown }[] }
    const got = data.embeddings ?? []
    if (got.length !== slice.length)
      throw new Error(`embedder returned ${got.length} vectors for ${slice.length} inputs`)
    for (const e of got) out.push(assertWidth(e.values))
  }
  return out
}
