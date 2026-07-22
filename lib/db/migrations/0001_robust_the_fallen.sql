CREATE TABLE "answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"slide_id" text NOT NULL,
	"participant_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"is_correct" boolean,
	"points_awarded" integer DEFAULT 0 NOT NULL,
	"response_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "answers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"nickname" text NOT NULL,
	"avatar_seed" text NOT NULL,
	"client_token" text NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"streak" integer DEFAULT 0 NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "participants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"status" text DEFAULT 'lobby' NOT NULL,
	"host_token" text NOT NULL,
	"current_slide_index" integer DEFAULT -1 NOT NULL,
	"current_slide_started_at" timestamp with time zone,
	"last_bcast" timestamp with time zone,
	"last_topn" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answers" ADD CONSTRAINT "answers_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participants" ADD CONSTRAINT "participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "answers_unique_idx" ON "answers" USING btree ("session_id","slide_id","participant_id");--> statement-breakpoint
CREATE INDEX "answers_session_slide_idx" ON "answers" USING btree ("session_id","slide_id");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_session_token_idx" ON "participants" USING btree ("session_id","client_token");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_active_code_idx" ON "sessions" USING btree ("code") WHERE "sessions"."status" <> 'ended';