# Atlas M7 Phase 2A Retrieval Evaluation Benchmark

**Run ID**: `2a97fb71`  
**Timestamp**: `2026-08-23T18:47:27.791Z`  
**Corpus Version**: `golden-corpus-v1`  
**Golden Set Version**: `golden-queries-v1`  
**Embedder**: `gemini-embedding-001` (768 dim)  
**Relevance Floor**: `0.5`  

## 1. Executive Summary & Acceptance Gates

### Acceptance Gates (Phase 2A)

| Gate | Description | Status | Details |
|---|---|---|---|
| **Gate 1** | Random Baseline Fails | **PASS** (Unit Verified) | Random baseline recall@10 < 0.25 on all documents |
| **Gate 2** | BM25 MRR < 1.000 (Headroom exists) | **PASS** (Unit Verified) | BM25 MRR between 0.679 and 0.845 |
| **Gate 3 (Run A)** | Arm Disagreement (Mutual unique wins) | **FAIL** | Vector wins: 2, BM25 wins: 0 |
| **Gate 3 (Run B)** | Arm Disagreement (Budget-normalized) | **FAIL** | Vector wins: 2, BM25 wins: 0 |
| **Gate 4 (Run A)** | Oracle Union > Single Arms | **PASS** | Oracle MRR 0.938 vs Max Single 0.917 (Headroom: +0.021) |
| **Gate 4 (Run B)** | Oracle Union > Single Arms (Budget-norm) | **PASS** | Oracle MRR 0.938 vs Max Single 0.917 (Headroom: +0.021) |

## 2. Run A: Production Fidelity (Vector top-20, BM25 top-20, Hybrid top-40 fused)

### Pooled Retrieval Performance across All 3 OpenStax Documents (n=40 gradable queries)

| Arm | Recall@5 | Recall@8 (Prod) | Recall@10 | MRR | All-Evidence@8 | Avg Latency | P95 Latency |
|---|---|---|---|---|---|---|---|
| **VECTOR** | 97.5% | 100.0% | 100.0% | 0.917 | 100.0% | 539ms | 640ms |
| **BM25** | 95.0% | 95.0% | 95.0% | 0.780 | 95.0% | 0ms | 1ms |
| **HYBRID** | 100.0% | 100.0% | 100.0% | 0.920 | 100.0% | 67ms | 128ms |
| *ORACLE (Ceiling)* | *97.5%* | *100.0%* | *100.0%* | *0.938* | *100.0%* | - | - |

### Per-Document Breakdown

#### Document: `openstax-social-psychology` (67 chunks)

| Arm | Recall@5 | Recall@8 | Recall@10 | MRR | All-Evidence@8 | Avg Latency |
|---|---|---|---|---|---|---|
| vector | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 549ms |
| bm25 | 100.0% | 100.0% | 100.0% | 0.845 | 100.0% | 0ms |
| hybrid | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 70ms |

#### Document: `openstax-big-bang` (70 chunks)

| Arm | Recall@5 | Recall@8 | Recall@10 | MRR | All-Evidence@8 | Avg Latency |
|---|---|---|---|---|---|---|
| vector | 100.0% | 100.0% | 100.0% | 0.962 | 100.0% | 559ms |
| bm25 | 100.0% | 100.0% | 100.0% | 0.810 | 100.0% | 0ms |
| hybrid | 100.0% | 100.0% | 100.0% | 0.962 | 100.0% | 65ms |

#### Document: `openstax-patent-enforcement` (64 chunks)

| Arm | Recall@5 | Recall@8 | Recall@10 | MRR | All-Evidence@8 | Avg Latency |
|---|---|---|---|---|---|---|
| vector | 92.3% | 100.0% | 100.0% | 0.782 | 100.0% | 507ms |
| bm25 | 84.6% | 84.6% | 84.6% | 0.679 | 84.6% | 0ms |
| hybrid | 100.0% | 100.0% | 100.0% | 0.791 | 100.0% | 66ms |

### Gate 3 Analysis: Mutual Unique Wins (runA)

#### Vector-Only Unique Wins (Vector in top-10, BM25 missed)
| Query ID | Category | Query | Vector Rank | BM25 Rank |
|---|---|---|---|---|
| `pt-p2` | semantic_paraphrase | What happens if a rights holder sits on a complaint for years before finally suing? | 1 | MISS |
| `pt-x2` | distractor | Who can be sued for patent infringement? | 6 | MISS |

#### BM25-Only Unique Wins (BM25 in top-10, Vector missed)
*None*

## 2. Run B: Budget-Normalized Comparison (Vector top-40, BM25 top-40, Hybrid top-40 fused)

### Pooled Retrieval Performance across All 3 OpenStax Documents (n=40 gradable queries)

| Arm | Recall@5 | Recall@8 (Prod) | Recall@10 | MRR | All-Evidence@8 | Avg Latency | P95 Latency |
|---|---|---|---|---|---|---|---|
| **VECTOR** | 97.5% | 100.0% | 100.0% | 0.917 | 100.0% | 80ms | 145ms |
| **BM25** | 95.0% | 95.0% | 95.0% | 0.780 | 95.0% | 0ms | 1ms |
| **HYBRID** | 100.0% | 100.0% | 100.0% | 0.920 | 100.0% | 85ms | 144ms |
| *ORACLE (Ceiling)* | *97.5%* | *100.0%* | *100.0%* | *0.938* | *100.0%* | - | - |

### Per-Document Breakdown

#### Document: `openstax-social-psychology` (67 chunks)

| Arm | Recall@5 | Recall@8 | Recall@10 | MRR | All-Evidence@8 | Avg Latency |
|---|---|---|---|---|---|---|
| vector | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 78ms |
| bm25 | 100.0% | 100.0% | 100.0% | 0.845 | 100.0% | 0ms |
| hybrid | 100.0% | 100.0% | 100.0% | 1.000 | 100.0% | 91ms |

#### Document: `openstax-big-bang` (70 chunks)

| Arm | Recall@5 | Recall@8 | Recall@10 | MRR | All-Evidence@8 | Avg Latency |
|---|---|---|---|---|---|---|
| vector | 100.0% | 100.0% | 100.0% | 0.962 | 100.0% | 90ms |
| bm25 | 100.0% | 100.0% | 100.0% | 0.810 | 100.0% | 0ms |
| hybrid | 100.0% | 100.0% | 100.0% | 0.962 | 100.0% | 72ms |

#### Document: `openstax-patent-enforcement` (64 chunks)

| Arm | Recall@5 | Recall@8 | Recall@10 | MRR | All-Evidence@8 | Avg Latency |
|---|---|---|---|---|---|---|
| vector | 92.3% | 100.0% | 100.0% | 0.782 | 100.0% | 71ms |
| bm25 | 84.6% | 84.6% | 84.6% | 0.679 | 84.6% | 0ms |
| hybrid | 100.0% | 100.0% | 100.0% | 0.791 | 100.0% | 92ms |

### Gate 3 Analysis: Mutual Unique Wins (runB)

#### Vector-Only Unique Wins (Vector in top-10, BM25 missed)
| Query ID | Category | Query | Vector Rank | BM25 Rank |
|---|---|---|---|---|
| `pt-p2` | semantic_paraphrase | What happens if a rights holder sits on a complaint for years before finally suing? | 1 | MISS |
| `pt-x2` | distractor | Who can be sued for patent infringement? | 6 | MISS |

#### BM25-Only Unique Wins (BM25 in top-10, Vector missed)
*None*


