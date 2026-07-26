ALTER TABLE "sessions" ADD COLUMN "revealed_slide_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- End duplicate live rooms BEFORE the unique index goes on. CREATE UNIQUE INDEX aborts if
-- any deck already has two non-ended sessions — precisely the state the pre-fix launch race
-- could leave behind, so a database that hit that bug is the one where this migration would
-- fail. Keep the newest room per deck (the one people are most likely in) and close the
-- strays; (created_at, id) breaks ties so exactly one row survives per deck.
UPDATE "sessions" s
SET "status" = 'ended', "ended_at" = now()
WHERE s."status" <> 'ended'
  AND s."deck_id" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "sessions" t
    WHERE t."deck_id" = s."deck_id"
      AND t."status" <> 'ended'
      AND (t."created_at", t."id") > (s."created_at", s."id")
  );--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_deck_idx" ON "sessions" USING btree ("deck_id") WHERE "sessions"."status" <> 'ended';
