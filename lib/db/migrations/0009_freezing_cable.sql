ALTER TABLE "decks" ADD COLUMN "share_token" text;--> statement-breakpoint
CREATE UNIQUE INDEX "decks_share_token_idx" ON "decks" USING btree ("share_token") WHERE "decks"."share_token" is not null;--> statement-breakpoint
-- No RLS policy is added for the public share page, deliberately.
--
-- /d/{token} is rendered on the SERVER and reads through the Drizzle connection, which
-- connects as `postgres` and bypasses RLS entirely (the policies on this table are defence
-- in depth for the anon-key path — see migration 0002). Adding an anon SELECT policy for
-- "shared decks" would make every shared deck readable by anyone holding the public anon
-- key, without the token, straight from the browser. The token gates the route, not the row.
--
-- The partial unique index above is the lookup path: shared decks are a small minority, and
-- the NULLs of every unshared deck stay out of the index.
