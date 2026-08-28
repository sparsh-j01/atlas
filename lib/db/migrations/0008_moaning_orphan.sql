CREATE TABLE "document_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"asset_index" integer NOT NULL,
	"entry_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"ocr_status" text DEFAULT 'pending' NOT NULL,
	"ocr_text" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "document_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "document_pages" ADD COLUMN "ocr_text" text;--> statement-breakpoint
ALTER TABLE "document_pages" ADD COLUMN "text_source" text DEFAULT 'digital' NOT NULL;--> statement-breakpoint
ALTER TABLE "document_pages" ADD COLUMN "unread_reason" text;--> statement-breakpoint
ALTER TABLE "document_assets" ADD CONSTRAINT "document_assets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_assets_doc_page_index_idx" ON "document_assets" USING btree ("document_id","page_number","asset_index");--> statement-breakpoint
CREATE INDEX "document_assets_doc_status_idx" ON "document_assets" USING btree ("document_id","ocr_status");--> statement-breakpoint
-- Widen the documents bucket to accept .pptx.
--
-- Storage enforces allowed_mime_types BEFORE any application code runs, so without this a
-- .pptx that passes every check in the upload route is still rejected by the bucket — the
-- one part of the ladder that no amount of app-side work can satisfy. Migration 0007
-- created the bucket with ARRAY['application/pdf']; this widens it in place rather than
-- editing 0007, which has already been applied.
--
-- file_size_limit is deliberately unchanged: UPLOAD_LIMITS.maxFileSize is still 25MB, and
-- the decompression guard in lib/ingest/zip.ts is what bounds a .pptx once unpacked.
UPDATE storage.buckets
SET allowed_mime_types = ARRAY[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
]
WHERE id = 'documents';--> statement-breakpoint
-- RLS: same shape as every other M7 table (migration 0007) — one FOR ALL policy scoped TO
-- authenticated, ownership resolved back to documents.owner_id. The anon key is public, so
-- anon gets no policy anywhere and RLS denies it by default.
--
-- The app reaches this table through the service-role connection and bypasses RLS; this is
-- defence in depth for the anon-key path.
CREATE POLICY "document_assets_all_own" ON "document_assets" FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "document_assets"."document_id" AND d.owner_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM "documents" d WHERE d.id = "document_assets"."document_id" AND d.owner_id = auth.uid()));
