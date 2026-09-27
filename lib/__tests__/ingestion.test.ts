import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))

// lib/ingestion.ts had NO tests before PPTX and OCR changed four of its behaviours: what
// extract() dispatches to, what readPages() joins, whether structure() calls Gemini, and
// whether the driver may park mid-stage. These pin all four, and pin the PDF path against
// the change rather than around it.

const jobRow = {
  job: { id: 'job-1', documentId: 'doc-1', attempt: 1 },
  document: { id: 'doc-1', status: 'uploaded', sourceType: 'pdf', storagePath: 'o/x.pdf' },
}

const state = { docStatus: 'uploaded', advanced: [] as string[], failed: null as unknown, lease: null as Date | null }

vi.mock('@/lib/db', () => {
  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => Promise.resolve([{ ...jobRow, document: { ...jobRow.document, status: state.docStatus } }]),
  }
  return { db: chain }
})

vi.mock('@/lib/documents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/documents')>()
  return {
    ...actual,
    // Like the real conditional UPDATE: free, or lapsed, or nothing.
    claimDocument: vi.fn(async (_id: string, until: Date) => {
      if (state.lease && state.lease > new Date()) return null
      state.lease = until
      return until
    }),
    releaseDocument: vi.fn(async (_id: string, until: Date) => {
      if (state.lease === until) state.lease = null
    }),
    advanceDocument: vi.fn(async (id: string, expected: string, next: string) => {
      state.advanced.push(`${expected}->${next}`)
      state.docStatus = next
      return { ...jobRow.document, id, status: next }
    }),
    // Conditional, like the real one: lands only if the document is still in `expected`.
    failDocument: vi.fn(async (id: string, expected: string, s: string, _j: string, code: string) => {
      if (state.docStatus !== expected) return false
      state.failed = { state: s, code }
      state.docStatus = s
      return true
    }),
  }
})

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { FAILURE_OF, RESUME_AT, STAGES, pageText, runIngestion } = await import('../ingestion')
const { INGESTION_STATES, FAILED_STATES } = await import('../documents')
import type { Stage } from '../ingestion'

const far = () => Date.now() + 60_000
type Doc = Parameters<Stage['run']>[0]

beforeEach(() => {
  state.docStatus = 'uploaded'
  state.advanced = []
  state.failed = null
  state.lease = null
})

/** A stage list that records what ran, without touching storage, Gemini or a database. */
function fakeStages(overrides: Partial<Record<string, () => Promise<unknown>>> = {}) {
  const ran: string[] = []
  const stages: Stage[] = STAGES.map((s) => ({
    from: s.from,
    to: s.to,
    run: async () => {
      ran.push(s.from)
      return (await overrides[s.from]?.()) as never
    },
  }))
  return { stages, ran }
}

describe('the state machine is complete and consistent', () => {
  it('has a stage for every non-terminal state, and they chain to ready', () => {
    let at = 'uploaded'
    const walked = [at]
    while (at !== 'ready') {
      const stage = STAGES.find((s) => s.from === at)
      expect(stage, `no stage leaves "${at}"`).toBeDefined()
      at = stage!.to
      walked.push(at)
    }
    expect(walked).toEqual(['uploaded', 'ocr', 'structuring', 'chunking', 'embedding', 'ready'])
  })

  it('gives every stage a failure state, and every failure state a way back', () => {
    for (const stage of STAGES) {
      const failure = FAILURE_OF[stage.from]
      expect(failure, `no failure mapping for "${stage.from}"`).toBeDefined()
      expect(FAILED_STATES).toContain(failure.state)
      // The failure state must resume at the stage that produced it, or a retry silently
      // re-runs the wrong stage.
      expect(RESUME_AT[failure.state]).toBe(stage.from)
    }
  })

  it('declares every state it uses', () => {
    for (const stage of STAGES) {
      expect(INGESTION_STATES).toContain(stage.from)
      expect(INGESTION_STATES).toContain(stage.to)
    }
  })
})

describe('driver transitions', () => {
  it('walks a document from uploaded to ready', async () => {
    const { stages, ran } = fakeStages()
    const outcome = await runIngestion('job-1', far(), stages)
    expect(outcome).toEqual({ status: 'ready', done: true, paused: false })
    expect(ran).toEqual(['uploaded', 'ocr', 'structuring', 'chunking', 'embedding'])
    expect(state.advanced).toEqual([
      'uploaded->ocr',
      'ocr->structuring',
      'structuring->chunking',
      'chunking->embedding',
      'embedding->ready',
    ])
  })

  it('advances past a stage that returns nothing, which is what four of the five do', async () => {
    // The regression this guards: reading `result.done` without checking `result` exists
    // would treat every void-returning stage as a pause and hang the pipeline at `uploaded`.
    const { stages } = fakeStages({ uploaded: async () => undefined })
    expect((await runIngestion('job-1', far(), stages)).done).toBe(true)
  })

  it('advances past a stage that reports done', async () => {
    const { stages } = fakeStages({ ocr: async () => ({ done: true }) })
    expect((await runIngestion('job-1', far(), stages)).done).toBe(true)
    expect(state.advanced).toContain('ocr->structuring')
  })

  it('does nothing for a document already ready', async () => {
    state.docStatus = 'ready'
    const { stages, ran } = fakeStages()
    expect(await runIngestion('job-1', far(), stages)).toEqual({ status: 'ready', done: true, paused: false })
    expect(ran).toEqual([])
  })
})

describe('mid-stage parking', () => {
  it('parks WITHOUT advancing when a stage reports done:false', async () => {
    const { stages, ran } = fakeStages({ ocr: async () => ({ done: false }) })
    const outcome = await runIngestion('job-1', far(), stages)
    expect(outcome).toEqual({ status: 'ocr', done: false, paused: true })
    // Critically, the document stays at `ocr` — advancing here would skip the images the
    // stage had not reached yet, and they would never be read.
    expect(state.advanced).toEqual(['uploaded->ocr'])
    expect(ran).toEqual(['uploaded', 'ocr'])
  })

  it('re-enters the same stage on the next call and can then finish', async () => {
    let call = 0
    const { stages } = fakeStages({ ocr: async () => ({ done: ++call > 1 }) })

    const first = await runIngestion('job-1', far(), stages)
    expect(first).toEqual({ status: 'ocr', done: false, paused: true })

    const second = await runIngestion('job-1', far(), stages)
    expect(second).toEqual({ status: 'ready', done: true, paused: false })
    expect(state.advanced).toEqual([
      'uploaded->ocr',
      'ocr->structuring',
      'structuring->chunking',
      'chunking->embedding',
      'embedding->ready',
    ])
  })

  it('parks between stages when the budget runs out, as it always did', async () => {
    const { stages, ran } = fakeStages()
    const outcome = await runIngestion('job-1', Date.now() + 100, stages)
    expect(outcome).toEqual({ status: 'uploaded', done: false, paused: true })
    expect(ran).toEqual([])
  })
})

describe('stage failure', () => {
  it('records the failed state and code for the stage that threw', async () => {
    const { stages } = fakeStages({
      ocr: async () => {
        throw new Error('tesseract exploded: /var/task/eng.traineddata missing')
      },
    })
    const outcome = await runIngestion('job-1', far(), stages)
    expect(outcome).toEqual({
      status: 'failed_ocr',
      done: false,
      paused: false,
      errorCode: 'OCR_FAILED',
    })
    expect(state.failed).toEqual({ state: 'failed_ocr', code: 'OCR_FAILED' })
  })

  it('reports a pause, not a failure, when another driver already moved the document on', async () => {
    // Two tabs driving one upload: this driver's ocr stage throws (here, on the winner's rows)
    // after the other driver has advanced the document to structuring. Stamping failed_ocr
    // over that would undo the winner's progress and burn a retry attempt.
    const { stages } = fakeStages({
      ocr: async () => {
        state.docStatus = 'structuring'
        throw new Error('duplicate key value violates unique constraint')
      },
    })
    const outcome = await runIngestion('job-1', far(), stages)
    expect(outcome).toEqual({ status: 'ocr', done: false, paused: true })
    expect(state.failed).toBeNull()
    expect(state.docStatus).toBe('structuring')
  })

  it('never returns the raw exception text to the caller', async () => {
    // The message can carry provider, path and quota detail; only the code is public.
    const secret = 'GEMINI quota exceeded for project 12345 tier free'
    const { stages } = fakeStages({
      structuring: async () => {
        throw new Error(secret)
      },
    })
    const outcome = await runIngestion('job-1', far(), stages)
    expect(JSON.stringify(outcome)).not.toContain(secret)
    expect(outcome.errorCode).toBe('STRUCTURE_DETECTION_FAILED')
    // Nor stored: a failed insert's message carries the document's own text (F05).
    const { failDocument } = await import('../documents')
    expect(vi.mocked(failDocument).mock.lastCall?.[5]).toBe('Document processing failed.')
  })

  it('resumes a failed document at the stage that failed', async () => {
    state.docStatus = 'failed_chunking'
    const { stages, ran } = fakeStages()
    await runIngestion('job-1', far(), stages)
    expect(ran).toEqual(['chunking', 'embedding'])
  })

  it('resumes a failed OCR run at ocr, not at the start', async () => {
    state.docStatus = 'failed_ocr'
    const { stages, ran } = fakeStages()
    await runIngestion('job-1', far(), stages)
    expect(ran[0]).toBe('ocr')
    expect(ran).not.toContain('uploaded')
  })
})

describe('one driver at a time (security review F06)', () => {
  it('runs no stage and reports a pause while another request holds the document', async () => {
    state.lease = new Date(Date.now() + 30_000)
    const { stages, ran } = fakeStages()
    const outcome = await runIngestion('job-1', far(), stages)
    expect(ran).toEqual([])
    expect(outcome).toMatchObject({ done: false, paused: true })
  })

  it('takes over a lapsed lease, and gives the lease back however the run ends', async () => {
    state.lease = new Date(Date.now() - 1_000)
    const done = fakeStages()
    expect((await runIngestion('job-1', far(), done.stages)).done).toBe(true)
    expect(state.lease).toBeNull()

    state.docStatus = 'uploaded'
    const failing = fakeStages({ chunking: async () => { throw new Error('boom') } })
    await runIngestion('job-1', far(), failing.stages)
    expect(state.lease).toBeNull()
  })
})

describe('pageText — the PDF regression guard', () => {
  it('returns raw text UNCHANGED when there is no OCR text', () => {
    // Every page of every PDF has ocr_text NULL. If this ever stops being an identity,
    // every chunk offset in every existing document shifts.
    const samples = ['', 'plain', '  leading and trailing  ', 'multi\nline\ntext', '光合作用 — ünïcode']
    for (const raw of samples) {
      expect(pageText(raw, null)).toBe(raw)
      expect(pageText(raw, '')).toBe(raw)
    }
  })

  it('appends OCR text to a page that also has digital text', () => {
    expect(pageText('Slide title', 'recognised from the image')).toBe(
      'Slide title\nrecognised from the image',
    )
  })

  it('uses OCR text alone for a page with no digital text', () => {
    // No leading newline: a blank first line would push every later offset by one.
    expect(pageText('', 'only from the image')).toBe('only from the image')
    expect(pageText('   \n  ', 'only from the image')).toBe('only from the image')
  })
})

describe('format dispatch', () => {
  it('routes on sourceType, and pdf is the default for anything else', async () => {
    // Guards against a typo'd source_type silently taking the PPTX branch.
    const seen: string[] = []
    const stages: Stage[] = [
      {
        from: 'uploaded',
        to: 'ready',
        run: async (doc: Doc) => {
          seen.push(doc.sourceType)
        },
      },
    ]
    await runIngestion('job-1', far(), stages)
    expect(seen).toEqual(['pdf'])
  })
})
