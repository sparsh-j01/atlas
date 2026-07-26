ALTER TABLE "sessions" ADD COLUMN "deck_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "host_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_host_id_profiles_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;