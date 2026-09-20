-- Polls removed 2026-10-05: quiz questions are the only slide type. answers.slide_id is text
-- with no FK, so a poll's answers would outlive their slide; they go first. No score moves:
-- poll answers were never graded and awarded 0 points. Positions are left with gaps, as an
-- ordinary slide delete leaves them. last_bcast was the live-count throttle, now removed.
DELETE FROM "answers" WHERE "slide_id" IN (SELECT "id"::text FROM "slides" WHERE "type" = 'poll');--> statement-breakpoint
DELETE FROM "slides" WHERE "type" = 'poll';--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "last_bcast";
