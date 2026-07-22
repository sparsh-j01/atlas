CREATE INDEX "decks_owner_id_idx" ON "decks" USING btree ("owner_id");--> statement-breakpoint
-- Backfill profiles for any auth.users that predate the 0002 handle_new_user trigger.
-- Without a profiles row, deck creation fails the decks.owner_id → profiles.id FK.
-- Idempotent: runs safely on already-seeded databases and on a fresh (empty) auth schema.
INSERT INTO public.profiles (id, email)
SELECT id, email FROM auth.users
ON CONFLICT (id) DO NOTHING;