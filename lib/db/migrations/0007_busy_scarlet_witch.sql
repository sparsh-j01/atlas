CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE TABLE "chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"page_start" integer NOT NULL,
	"page_end" integer NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"text" text NOT NULL,
	"token_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"raw_text" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "document_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"heading" text NOT NULL,
	"page_start" integer NOT NULL,
	"page_end" integer NOT NULL,
	"start_offset" integer NOT NULL,
	"end_offset" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_sections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"deck_id" uuid,
	"filename" text NOT NULL,
	"source_type" text NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"file_size" integer NOT NULL,
	"page_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chunk_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"version" text NOT NULL,
	"dimension" integer NOT NULL,
	"vector" vector(768) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "embeddings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "generation_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generated_slide_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"page" integer NOT NULL,
	"section" text NOT NULL,
	"char_start" integer NOT NULL,
	"char_end" integer NOT NULL,
	"support_score" real
);
--> statement-breakpoint
ALTER TABLE "generation_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "ingestion_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"status" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_section_id_document_sections_id_fk" FOREIGN KEY ("section_id") REFERENCES "public"."document_sections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_sections" ADD CONSTRAINT "document_sections_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_deck_id_decks_id_fk" FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_sources" ADD CONSTRAINT "generation_sources_generated_slide_id_slides_id_fk" FOREIGN KEY ("generated_slide_id") REFERENCES "public"."slides"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_sources" ADD CONSTRAINT "generation_sources_chunk_id_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_sources" ADD CONSTRAINT "generation_sources_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingestion_jobs" ADD CONSTRAINT "ingestion_jobs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chunks_doc_idx_idx" ON "chunks" USING btree ("document_id","chunk_index");--> statement-breakpoint
CREATE INDEX "chunks_section_id_idx" ON "chunks" USING btree ("section_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_pages_doc_page_idx" ON "document_pages" USING btree ("document_id","page_number");--> statement-breakpoint
CREATE UNIQUE INDEX "document_sections_doc_offset_idx" ON "document_sections" USING btree ("document_id","start_offset");--> statement-breakpoint
CREATE INDEX "documents_owner_id_idx" ON "documents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "documents_deck_id_idx" ON "documents" USING btree ("deck_id");--> statement-breakpoint
CREATE UNIQUE INDEX "embeddings_chunk_provider_model_version_idx" ON "embeddings" USING btree ("chunk_id","provider","model","version");--> statement-breakpoint
CREATE INDEX "generation_sources_slide_idx" ON "generation_sources" USING btree ("generated_slide_id");--> statement-breakpoint
CREATE INDEX "ingestion_jobs_doc_status_idx" ON "ingestion_jobs" USING btree ("document_id","status");
--> statement-breakpoint
-- Private storage bucket for uploaded source documents. Nothing else in the repo creates
-- it, so ingestion downloaded from a bucket that did not exist. Private: objects are
-- reached only through the service-role client in lib/ingestion.ts, never by public URL.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('documents', 'documents', false, 26214400, ARRAY['application/pdf'])
ON CONFLICT (id) DO NOTHING;--> statement-breakpoint
-- Objects are namespaced by owner id (see app/api/decks/ingest-pdf/route.ts), so the
-- first path segment is the tenant boundary.
CREATE POLICY "documents_objects_own" ON storage.objects FOR ALL TO authenticated
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text)
  WITH CHECK (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text);--> statement-breakpoint
-- RLS: creator-owned tables follow the migration 0002 pattern — one FOR ALL policy scoped
-- TO authenticated, ownership resolved back to documents.owner_id. The anon key is public,
-- so anon gets no policy anywhere and RLS denies it by default.
--
-- The app reaches these tables through the service-role connection and bypasses RLS; these
-- policies exist so a future client-side read cannot become a tenant leak.
CREATE POLICY "documents_all_own" ON "documents" FOR ALL TO authenticated
  USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());--> statement-breakpoint
CREATE POLICY "document_pages_all_own" ON "document_pages" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "document_pages"."document_id" AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "document_pages"."document_id" AND d.owner_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "document_sections_all_own" ON "document_sections" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "document_sections"."document_id" AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "document_sections"."document_id" AND d.owner_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "chunks_all_own" ON "chunks" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "chunks"."document_id" AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "chunks"."document_id" AND d.owner_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "embeddings_all_own" ON "embeddings" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "chunks" c JOIN "documents" d ON d.id = c.document_id WHERE c.id = "embeddings"."chunk_id" AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "chunks" c JOIN "documents" d ON d.id = c.document_id WHERE c.id = "embeddings"."chunk_id" AND d.owner_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "generation_sources_all_own" ON "generation_sources" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "generation_sources"."document_id" AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "generation_sources"."document_id" AND d.owner_id = auth.uid()));--> statement-breakpoint
CREATE POLICY "ingestion_jobs_all_own" ON "ingestion_jobs" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "ingestion_jobs"."document_id" AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "ingestion_jobs"."document_id" AND d.owner_id = auth.uid()));
