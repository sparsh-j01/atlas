import { config } from 'dotenv'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { chunks } from '@/lib/db/schema'
import { createRetriever } from '@/lib/ai/retrieve'
import { CORPUS_DOCUMENTS } from '../documents/openstax-corpus'
import { GOLDEN_QUERIES } from '../documents/golden-queries'
import { EVAL_OWNER_ID, evalDocumentId } from '../seed-ids'

config({ path: '.env.local', quiet: true })

/**
 * Phase 2D, master doc section 13 — tenant isolation, the DB-backed half.
 *
 * PATH A (the owner-scoped corpus load) can only be proven against real rows, so it lives
 * here rather than in the vitest suite: CI has no database. PATH B (the in-memory
 * re-filter) is the opposite — it is unreachable on the cross-owner path, because a
 * foreign owner loads zero rows and `vectorSearch` returns early on an empty corpus. It is
 * covered by `tenant-isolation.test.ts`, which runs in CI on every push.
 *
 * Splitting them is the point. A single cross-owner test passes because the owner join
 * worked, and would pass identically with the re-filter deleted.
 *
 * Cost: two query embeddings. No generation calls.
 */

const FOREIGN_OWNER = createHash('sha256').update('atlas:eval:foreign-tenant').digest('hex')
const asUuid = (h: string) =>
  `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`

interface Check {
  name: string
  passed: boolean
  detail: string
}

async function main(): Promise<void> {
  const ownerId = process.env.EVAL_OWNER_ID || EVAL_OWNER_ID
  const foreignOwnerId = asUuid(FOREIGN_OWNER)
  const [docA, docB] = CORPUS_DOCUMENTS
  const docAId = evalDocumentId(docA.id)
  const docBId = evalDocumentId(docB.id)
  const checks: Check[] = []

  console.log('========== PHASE 2D: TENANT ISOLATION ==========')
  console.log(`Legitimate owner : ${ownerId}`)
  console.log(`Foreign tenant   : ${foreignOwnerId} (owns nothing)`)
  console.log(`Document A       : ${docA.id}`)
  console.log(`Document B       : ${docB.id}\n`)

  // --- A1: a foreign tenant naming a real document id loads an empty corpus ------------
  const foreign = await createRetriever(docAId, foreignOwnerId)
  checks.push({
    name: 'A1 direct document-id abuse loads zero chunks',
    passed: foreign.chunkCount() === 0,
    detail: `chunkCount=${foreign.chunkCount()} (expected 0)`,
  })

  // --- A2: and retrieval over it yields nothing, rather than erroring into a fallback ---
  // No embedding is spent: retrieve() short-circuits on an empty corpus.
  const foreignHits = await foreign.retrieve('patent infringement damages', 8)
  checks.push({
    name: 'A2 foreign-tenant retrieval returns no evidence',
    passed: foreignHits.length === 0,
    detail: `results=${foreignHits.length} (expected 0)`,
  })

  // --- A3: the outline leaks nothing either. Section headings are document content. -----
  checks.push({
    name: 'A3 foreign tenant sees no section outline',
    passed: foreign.outline().length === 0,
    detail: `sections=${foreign.outline().length} (expected 0)`,
  })

  // --- B1: the legitimate owner asking document A for document B's content -------------
  // The master doc's scenario: query one document with another's subject matter and prove
  // no foreign chunk crosses over. This one DOES spend an embedding.
  //
  // The owned/foreign sets come from the DATABASE, not from a retrieve() call. An earlier
  // version enumerated document A by retrieving with topK=100, which is wrong and failed
  // this check for the wrong reason: retrieval fuses a vector top-20 with a BM25 top-20, so
  // it can never return more than ~40 candidates however large topK is. Two-thirds of the
  // owned corpus therefore looked "foreign" and the check reported a leak that did not
  // exist. A test that fails for the wrong reason hides the failure it was written to find.
  const idsOf = async (documentId: string) =>
    new Set((await db.select({ id: chunks.id }).from(chunks).where(eq(chunks.documentId, documentId))).map((r) => r.id))
  const aIds = await idsOf(docAId)
  const bIds = await idsOf(docBId)

  const legit = await createRetriever(docAId, ownerId)
  // A real graded query for document B, not a hand-written probe: it is known to have
  // evidence in B, so if scoping ever broke, this is a query that WOULD pull B's chunks.
  const probe = GOLDEN_QUERIES.find((q) => q.documentId === docB.id && q.evidenceSpans.length > 0)
  if (!probe) throw new Error(`no gradable golden query for ${docB.id}; cannot probe cross-document leakage`)
  const crossTopic = await legit.retrieve(probe.query, 8)
  const fromB = crossTopic.filter((r) => bIds.has(r.chunkId))
  const notFromA = crossTopic.filter((r) => !aIds.has(r.chunkId))
  checks.push({
    name: 'B1 cross-document query returns only document A chunks',
    passed: fromB.length === 0 && notFromA.length === 0,
    detail:
      `evidence=${crossTopic.length}, from document B=${fromB.length} (expected 0), ` +
      `not from document A=${notFromA.length} (expected 0), probe [${probe.id}] "${probe.query}"`,
  })

  // --- B2: document B's own corpus is non-empty, so B1 is not vacuous ------------------
  checks.push({
    name: 'B2 document B is actually populated (B1 is not vacuous)',
    passed: bIds.size > 0 && aIds.size > 0,
    detail: `documentA chunks=${aIds.size}, documentB chunks=${bIds.size} (both expected > 0)`,
  })

  console.log('---------- RESULTS ----------')
  for (const c of checks) {
    console.log(`  ${c.passed ? 'PASS' : 'FAIL'}  ${c.name}\n        ${c.detail}`)
  }
  const failed = checks.filter((c) => !c.passed)
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
  if (failed.length > 0) process.exit(1)
}

main().catch((err) => {
  console.error('Tenant isolation evaluation failed:', err)
  process.exit(1)
})
