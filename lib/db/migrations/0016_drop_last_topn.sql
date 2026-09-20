-- last_topn held the previous top-N for the rank-movement chips, removed with them on
-- 2026-10-06. Nothing reads or writes it.
ALTER TABLE "sessions" DROP COLUMN "last_topn";