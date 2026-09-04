/**
 * Post-session results: pure shaping + CSV, no database and no `server-only`.
 *
 * The queries live in lib/sessions.ts (the server-only module that already owns sessions);
 * everything here takes rows in and returns plain data, so the interesting parts — the
 * per-question tally, the gradebook pivot, CSV escaping — are unit-testable without a
 * connection. Same split as lib/mcq.ts (pure) against lib/decks.ts (server-only).
 *
 * ## The join this module has to survive
 *
 * `answers.slide_id` is TEXT with no foreign key, on purpose: answers outlive the slide they
 * were given for, so editing or deleting a deck cannot cascade away a finished game's record
 * (see the comment on the table in lib/db/schema.ts). The cost of that decision is paid here.
 * Three things can be true by the time a teacher opens the results:
 *
 *   1. The slide was deleted. There are answers whose `slideId` matches nothing in the deck.
 *   2. The whole deck was deleted. `sessions.deck_id` is ON DELETE SET NULL, so there is no
 *      deck to read slides from at all, but the participants and their scores are intact.
 *   3. The slide was edited. Its prompt and its option ids may both have moved on, so an
 *      answer can point at an option that no longer exists.
 *
 * None of the three is an error and none of them may lose a row. A question whose text is
 * gone still reports how many people answered it; an answer pointing at a deleted option
 * still counts toward the total and is reported as `strayCount` rather than silently
 * dropped, because a tally that quietly loses answers is worse than one that says it did.
 *
 * ponytail: the honest fix is snapshotting each slide into the session at launch, which
 * makes results immutable and removes all three cases. That is a migration plus a write on
 * the hot launch path, and it only matters once decks are edited between runs often enough
 * for "Slide removed" to show up in front of someone. Upgrade path if it does: a
 * `session_slides` table written by createSessionFromDeck, read here instead of `decks`.
 */
import { isScored, type SlideType } from './slides'
import type { SlideConfig } from './slides'

export type ResultOption = {
  id: string
  text: string
  isCorrect: boolean
  count: number
}

export type QuestionResult = {
  slideId: string
  /** 1-based, in deck order. Questions whose slide is gone sort last and keep numbering. */
  number: number
  type: SlideType | null
  /** null when the slide (or its whole deck) has been deleted since the session ran. */
  prompt: string | null
  scored: boolean
  options: ResultOption[]
  /** Answers pointing at an option id the slide no longer has. Counted, never dropped. */
  strayCount: number
  answered: number
  /** Scored slides only; 0 on a poll, which has nothing to be right about. */
  correct: number
  avgResponseMs: number | null
}

export type ParticipantResult = {
  participantId: string
  nickname: string
  avatarSeed: string
  rank: number
  score: number
  answered: number
  correct: number
  /** Keyed by slideId. Absent = did not answer that question. */
  bySlide: Record<
    string,
    { optionId: string; optionText: string | null; isCorrect: boolean | null; points: number }
  >
}

export type SessionResults = {
  questions: QuestionResult[]
  participants: ParticipantResult[]
  /** Rows that survived a deck deletion and have no question to sit under. */
  deckDeleted: boolean
}

/** The rows this module needs, named so the caller's query shape is obvious at the call site. */
export type AnswerRow = {
  slideId: string
  participantId: string
  optionId: string
  isCorrect: boolean | null
  pointsAwarded: number
  responseMs: number
}

export type ParticipantRow = {
  participantId: string
  nickname: string
  avatarSeed: string
  score: number
}

export type SlideRow = {
  id: string
  type: string
  prompt: string
  config: SlideConfig
  position: number
}

function optionsOf(config: SlideConfig): { id: string; text: string; isCorrect: boolean }[] {
  return config.options.map((o) => ({
    id: o.id,
    text: o.text,
    // Only an McqOption carries is_correct; a PollOption has no such field, so this is the
    // structural check rather than a slide-type branch (lib/poll.ts explains why).
    isCorrect: 'is_correct' in o && o.is_correct === true,
  }))
}

/**
 * Fold answers into per-question and per-participant views.
 *
 * `slides` is the deck as it stands NOW, which may be missing slides the session used and
 * may contain slides added since — so deck membership alone cannot decide what was asked. A
 * slide becomes a question if it was ANSWERED, or if it was REVEALED (`sessions.revealed_
 * slide_ids`, which the advance route already maintains so a re-shown slide cannot reopen
 * scoring). Those two together are what the session actually put in front of the room:
 *
 *   - answered, still in the deck   → a full question
 *   - answered, deleted since       → a question with no prompt
 *   - revealed, nobody answered     → a question reading 0 of N, which is a real finding and
 *                                     the reason this is not just "has answers"
 *   - in the deck, added afterwards → skipped; it was never asked
 *
 * A slide the host skipped past without revealing and which nobody answered is invisible
 * here, which is correct: nothing happened on it.
 */
export function shapeResults(
  slides: SlideRow[],
  participants: ParticipantRow[],
  answers: AnswerRow[],
  shownSlideIds: string[] = [],
): SessionResults {
  const shown = new Set(shownSlideIds)
  const byId = new Map(slides.map((s) => [s.id, s]))
  const answersBySlide = new Map<string, AnswerRow[]>()
  for (const a of answers) {
    const list = answersBySlide.get(a.slideId)
    if (list) list.push(a)
    else answersBySlide.set(a.slideId, [a])
  }

  // Deck order first, then any answered slide the deck no longer has. Both keep a stable
  // order so two loads of the same results page number the questions identically.
  const ordered = [...slides].sort((a, b) => a.position - b.position).map((s) => s.id)
  const orphans = [...answersBySlide.keys()].filter((id) => !byId.has(id)).sort()
  const slideIds = [...ordered, ...orphans].filter(
    (id) => answersBySlide.has(id) || shown.has(id),
  )

  const questions: QuestionResult[] = slideIds.map((slideId, i) => {
    const slide = byId.get(slideId)
    const rows = answersBySlide.get(slideId) ?? []
    const opts = slide ? optionsOf(slide.config) : []
    const counts = new Map(opts.map((o) => [o.id, 0]))
    let stray = 0
    for (const r of rows) {
      const seen = counts.get(r.optionId)
      if (seen === undefined) stray++
      else counts.set(r.optionId, seen + 1)
    }
    const scored = slide ? isScored(slide.type) : false
    return {
      slideId,
      number: i + 1,
      type: (slide?.type as SlideType) ?? null,
      prompt: slide?.prompt ?? null,
      scored,
      options: opts.map((o) => ({ ...o, count: counts.get(o.id) ?? 0 })),
      strayCount: stray,
      answered: rows.length,
      correct: scored ? rows.filter((r) => r.isCorrect === true).length : 0,
      avgResponseMs: rows.length
        ? Math.round(rows.reduce((n, r) => n + r.responseMs, 0) / rows.length)
        : null,
    }
  })

  const optionText = new Map<string, string>()
  for (const s of slides) for (const o of optionsOf(s.config)) optionText.set(o.id, o.text)

  const answersByParticipant = new Map<string, AnswerRow[]>()
  for (const a of answers) {
    const list = answersByParticipant.get(a.participantId)
    if (list) list.push(a)
    else answersByParticipant.set(a.participantId, [a])
  }

  // Same ordering as the live leaderboard (lib/realtime/aggregate.ts): score descending,
  // ties broken on participantId so a reload never reshuffles equal scores.
  const ranked = [...participants].sort(
    (a, b) => b.score - a.score || a.participantId.localeCompare(b.participantId),
  )

  const participantResults: ParticipantResult[] = ranked.map((p, i) => {
    const rows = answersByParticipant.get(p.participantId) ?? []
    const bySlide: ParticipantResult['bySlide'] = {}
    for (const r of rows) {
      bySlide[r.slideId] = {
        optionId: r.optionId,
        optionText: optionText.get(r.optionId) ?? null,
        isCorrect: r.isCorrect,
        points: r.pointsAwarded,
      }
    }
    return {
      participantId: p.participantId,
      nickname: p.nickname,
      avatarSeed: p.avatarSeed,
      rank: i + 1,
      score: p.score,
      answered: rows.length,
      correct: rows.filter((r) => r.isCorrect === true).length,
      bySlide,
    }
  })

  return {
    questions,
    participants: participantResults,
    deckDeleted: slides.length === 0 && questions.length > 0,
  }
}

/**
 * Escape one CSV field.
 *
 * The quoting half is ordinary RFC 4180. The leading apostrophe is not: a spreadsheet treats
 * a cell starting with `=`, `+`, `-`, `@`, or a lone tab/CR as a FORMULA, so a participant
 * who joins a public room as `=cmd|'/c calc'!A0` gets that evaluated on the teacher's machine
 * when they open the export. Nicknames here are attacker-controlled by design — joining takes
 * no account, only a 6-digit code off a projector — so this is a trust boundary, not
 * hypothetical tidiness. Prefixing with `'` makes the spreadsheet treat it as text; the
 * apostrophe is not shown in the cell.
 *
 * sanitizeNickname (lib/nickname.ts) does not cover this and should not: it is guarding what
 * lands on a projector, and `=` is a legitimate character there.
 */
export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return ''
  const s = String(value)
  const risky = /^[=+\-@\t\r]/.test(s)
  const body = risky ? `'${s}` : s
  return /[",\n\r]/.test(body) || risky ? `"${body.replace(/"/g, '""')}"` : body
}

/**
 * The gradebook export: one row per participant, one column per question.
 *
 * Wide rather than long (one row per answer) because the reader is a teacher opening this in
 * Excel or Sheets to see who got what, not an analyst pivoting it. The question text rides in
 * the column HEADER — `Q3: Which set of conditions…` — so the file explains itself without a
 * second sheet and stays valid single-header CSV.
 *
 * A scored cell is the points awarded; a poll cell is the option they chose, because points
 * are meaningless there and the choice is the whole content. Cells stay consistent down a
 * column, which is the axis a spreadsheet sorts and charts on.
 */
export function toGradebookCsv(results: SessionResults): string {
  const { questions, participants } = results
  const header = [
    'Nickname',
    'Rank',
    'Score',
    'Answered',
    'Correct',
    ...questions.map((q) => `Q${q.number}: ${q.prompt ?? 'Slide removed'}`),
  ]
  const rows = participants.map((p) => [
    p.nickname,
    p.rank,
    p.score,
    p.answered,
    p.correct,
    ...questions.map((q) => {
      const a = p.bySlide[q.slideId]
      if (!a) return ''
      // A removed option still reports the id rather than an empty cell — the answer existed,
      // and a blank would read as "did not answer".
      return q.scored ? a.points : (a.optionText ?? `(removed option ${a.optionId.slice(0, 8)})`)
    }),
  ])
  // CRLF and a UTF-8 BOM: Excel on Windows reads a BOM-less UTF-8 CSV as the system codepage,
  // which mangles every non-ASCII nickname in a classroom that has any.
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** `results-2026-09-04-1430.csv`, from the session's end time. Safe on every filesystem. */
export function csvFilename(deckTitle: string | null, endedAt: Date | null): string {
  const slug = (deckTitle ?? 'session')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40)
  const d = endedAt ?? new Date()
  const stamp = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-')
  return `${slug || 'session'}-results-${stamp}.csv`
}
