-- Add the referenced unique key before the composite foreign key.
CREATE UNIQUE INDEX "document_sections_id_document_idx" ON "document_sections" ("id", "document_id");
--> statement-breakpoint
ALTER TABLE "chunks" ADD CONSTRAINT "chunks_section_document_fk"
  FOREIGN KEY ("section_id", "document_id") REFERENCES "document_sections" ("id", "document_id") ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "settled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
-- Workflow, extracted content and budget state are server-managed. Keep owner reads.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON documents, document_pages, document_assets, document_sections, chunks, embeddings,
     generation_sources, ingestion_jobs, ai_usage, entitlements, rate_limits
  FROM anon, authenticated, PUBLIC;
--> statement-breakpoint
DROP POLICY IF EXISTS "documents_all_own" ON documents;
--> statement-breakpoint
CREATE POLICY "documents_read_own" ON documents FOR SELECT TO authenticated USING (owner_id = auth.uid());
--> statement-breakpoint
DROP POLICY IF EXISTS "document_pages_all_own" ON "document_pages";
--> statement-breakpoint
CREATE POLICY "document_pages_read_own" ON "document_pages" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = "document_pages".document_id AND d.owner_id = auth.uid()));
--> statement-breakpoint
DROP POLICY IF EXISTS "document_assets_all_own" ON "document_assets";
--> statement-breakpoint
CREATE POLICY "document_assets_read_own" ON "document_assets" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = "document_assets".document_id AND d.owner_id = auth.uid()));
--> statement-breakpoint
DROP POLICY IF EXISTS "document_sections_all_own" ON "document_sections";
--> statement-breakpoint
CREATE POLICY "document_sections_read_own" ON "document_sections" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = "document_sections".document_id AND d.owner_id = auth.uid()));
--> statement-breakpoint
DROP POLICY IF EXISTS "chunks_all_own" ON "chunks";
--> statement-breakpoint
CREATE POLICY "chunks_read_own" ON "chunks" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = "chunks".document_id AND d.owner_id = auth.uid()));
--> statement-breakpoint
DROP POLICY IF EXISTS "generation_sources_all_own" ON "generation_sources";
--> statement-breakpoint
CREATE POLICY "generation_sources_read_own" ON "generation_sources" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = "generation_sources".document_id AND d.owner_id = auth.uid()));
--> statement-breakpoint
DROP POLICY IF EXISTS "ingestion_jobs_all_own" ON "ingestion_jobs";
--> statement-breakpoint
CREATE POLICY "ingestion_jobs_read_own" ON "ingestion_jobs" FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM documents d WHERE d.id = "ingestion_jobs".document_id AND d.owner_id = auth.uid()));
--> statement-breakpoint
DROP POLICY IF EXISTS "embeddings_all_own" ON embeddings;
--> statement-breakpoint
CREATE POLICY "embeddings_read_own" ON embeddings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM chunks c JOIN documents d ON d.id = c.document_id
    WHERE c.id = embeddings.chunk_id AND d.owner_id = auth.uid()));
--> statement-breakpoint
-- All application uploads use the service role after validating bytes and quotas.
DROP POLICY IF EXISTS "documents_objects_own" ON storage.objects;
--> statement-breakpoint
CREATE POLICY "documents_objects_read_own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'documents' AND (storage.foldername(name))[1] = auth.uid()::text);
--> statement-breakpoint
-- Restrictive guards also protect this bucket if another permissive policy is added later.
CREATE POLICY "documents_objects_no_client_insert" ON storage.objects AS RESTRICTIVE FOR INSERT TO anon, authenticated
  WITH CHECK (bucket_id <> 'documents');
--> statement-breakpoint
CREATE POLICY "documents_objects_no_client_update" ON storage.objects AS RESTRICTIVE FOR UPDATE TO anon, authenticated
  USING (bucket_id <> 'documents') WITH CHECK (bucket_id <> 'documents');
--> statement-breakpoint
CREATE POLICY "documents_objects_no_client_delete" ON storage.objects AS RESTRICTIVE FOR DELETE TO anon, authenticated
  USING (bucket_id <> 'documents');
--> statement-breakpoint
-- Previous versions stored raw DB/provider messages in owner-readable job records.
UPDATE ingestion_jobs SET error_message = 'Document processing failed.' WHERE error_message IS NOT NULL;
