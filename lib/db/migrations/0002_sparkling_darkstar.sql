CREATE TABLE "decks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"source_type" text DEFAULT 'manual' NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "decks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "slides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deck_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"type" text NOT NULL,
	"prompt" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slides" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "decks" ADD CONSTRAINT "decks_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "slides" ADD CONSTRAINT "slides_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Deferrable so a reorder can rewrite every slide's position in one transaction
-- (uniqueness checked at commit, not per-row). See lib/decks.ts reorderSlides.
ALTER TABLE "slides" ADD CONSTRAINT "slides_deck_position_key" UNIQUE ("deck_id", "position") DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint

-- RLS policies (Drizzle enables RLS but can't express policies). decks/slides are
-- owner-only on the authenticated anon-key path; the app itself goes through Drizzle
-- (service-role, bypasses RLS) scoped by owner_id, so these are defense-in-depth.
CREATE POLICY "profiles_select_own" ON "profiles" FOR SELECT TO authenticated USING (auth.uid() = id);--> statement-breakpoint
CREATE POLICY "profiles_update_own" ON "profiles" FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);--> statement-breakpoint
CREATE POLICY "decks_all_own" ON "decks" FOR ALL TO authenticated USING (auth.uid() = owner_id) WITH CHECK (auth.uid() = owner_id);--> statement-breakpoint
CREATE POLICY "slides_all_own" ON "slides" FOR ALL TO authenticated USING (EXISTS (SELECT 1 FROM "decks" d WHERE d.id = "slides"."deck_id" AND d.owner_id = auth.uid())) WITH CHECK (EXISTS (SELECT 1 FROM "decks" d WHERE d.id = "slides"."deck_id" AND d.owner_id = auth.uid()));--> statement-breakpoint

-- Seed a profiles row on signup (all auth paths). SECURITY DEFINER + empty search_path
-- is the hardened Supabase pattern; the insert bypasses RLS (no user INSERT policy).
CREATE FUNCTION public.handle_new_user() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.profiles (id, email) VALUES (NEW.id, NEW.email)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();