import type { Retriever, RetrievalResult, RetrievalArm } from '@/lib/ai/retrieve'
import { VECTOR_LIMIT, BM25_LIMIT } from '@/lib/ai/retrieve'
import type { RetrieverLike } from './grade'

// Retrieval arms and candidate-pool configurations for Phase 2A evaluation (M7 §6).
//
// Candidate pool sizes must be explicitly tracked and reported:
//
// Run A — production fidelity:
//   Vector 20, BM25 20, Hybrid 20+20 (up to 40 fused).
//   Answers: "What does the deployed system actually do?"
//
// Run B — budget-normalised algorithm comparison:
//   Vector 40, BM25 40, Hybrid 20+20 (40 candidates total).
//   Answers: "Is RRF fusion a better algorithm than either arm alone when candidate budget is equal?"

export type EvalArm = 'vector' | 'bm25' | 'hybrid'
export type EvalRunMode = 'runA' | 'runB'

export interface ArmPoolConfig {
  arm: EvalArm
  runMode: EvalRunMode
  vectorLimit: number
  bm25Limit: number
  description: string
}

export const POOL_CONFIGS: Record<EvalRunMode, Record<EvalArm, ArmPoolConfig>> = {
  runA: {
    vector: {
      arm: 'vector',
      runMode: 'runA',
      vectorLimit: VECTOR_LIMIT, // 20
      bm25Limit: 0,
      description: 'Run A (prod fidelity): Vector top-20',
    },
    bm25: {
      arm: 'bm25',
      runMode: 'runA',
      vectorLimit: 0,
      bm25Limit: BM25_LIMIT, // 20
      description: 'Run A (prod fidelity): BM25 top-20',
    },
    hybrid: {
      arm: 'hybrid',
      runMode: 'runA',
      vectorLimit: VECTOR_LIMIT, // 20
      bm25Limit: BM25_LIMIT, // 20
      description: 'Run A (prod fidelity): Hybrid RRF 20+20',
    },
  },
  runB: {
    vector: {
      arm: 'vector',
      runMode: 'runB',
      vectorLimit: 40,
      bm25Limit: 0,
      description: 'Run B (budget-normalized): Vector top-40',
    },
    bm25: {
      arm: 'bm25',
      runMode: 'runB',
      vectorLimit: 0,
      bm25Limit: 40,
      description: 'Run B (budget-normalized): BM25 top-40',
    },
    hybrid: {
      arm: 'hybrid',
      runMode: 'runB',
      vectorLimit: 20,
      bm25Limit: 20,
      description: 'Run B (budget-normalized): Hybrid RRF 20+20',
    },
  },
}

/**
 * Adapt a production Retriever to evaluate a specific arm and candidate pool limit.
 */
export function createArmRetriever(
  retriever: Retriever,
  config: ArmPoolConfig,
): RetrieverLike<RetrievalResult> {
  let lastTiming: { totalMs: number; embeddingMs: number; searchMs: number; cacheStatus: 'cache_hit' | 'cache_miss' | 'not_applicable' } | undefined
  return {
    getLastTiming: () => lastTiming,
    retrieve: async (query: string, topK: number) => {
      return retriever.retrieve(query, topK, {
        arm: config.arm as RetrievalArm,
        vectorLimit: config.vectorLimit,
        bm25Limit: config.bm25Limit,
        onTiming: (t) => {
          lastTiming = t
        },
      })
    },
  }
}
