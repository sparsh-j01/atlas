import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

// The tenant boundary for anything M7.5 adds, checked against the migrations that create
// it. The live database was verified directly after `db:migrate`; this is the guard that
// keeps a LATER migration from quietly widening it, which no amount of app-side testing
// would notice.
//
// M7's own isolation eval is untouched — see evals/security/. This covers only the new
// table and the new storage allowlist.

const MIGRATIONS_DIR = path.join(process.cwd(), 'lib', 'db', 'migrations')

const allSql = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8') }))

const combined = allSql.map((m) => m.sql).join('\n')

describe('document_assets tenant isolation', () => {
  it('has row level security enabled', () => {
    expect(combined).toMatch(/ALTER TABLE "document_assets" ENABLE ROW LEVEL SECURITY/)
  })

  it('resolves ownership back to documents.owner_id, not to a column of its own', () => {
    // An owner_id column on this table would be a second source of truth that could drift
    // from the document's. Ownership is joined, exactly as every other M7 table does it.
    const policy = combined.match(/CREATE POLICY "document_assets_all_own"[\s\S]*?;/)?.[0] ?? ''
    expect(policy).toBeTruthy()
    expect(policy).toContain('FROM "documents" d')
    expect(policy).toContain('d.owner_id = auth.uid()')
    // Both directions: USING gates reads, WITH CHECK gates writes. One without the other
    // leaves half the table open.
    expect(policy).toContain('USING')
    expect(policy).toContain('WITH CHECK')
  })

  it('grants the policy to authenticated only', () => {
    expect(combined).toMatch(/CREATE POLICY "document_assets_all_own" ON "document_assets" FOR ALL TO authenticated/)
  })

  it('cascades from the document, so deleting a document takes its assets with it', () => {
    expect(combined).toMatch(
      /"document_assets" ADD CONSTRAINT "document_assets_document_id_documents_id_fk"[\s\S]*?ON DELETE cascade/,
    )
  })
})

/** Every CREATE POLICY statement, parsed one at a time. Matching across the whole file
 *  lets a lazy regex run from one statement's name into a later statement's role list,
 *  which reports a policy as granting anon when it does not. */
const policyStatements = (combined.match(/CREATE POLICY[\s\S]*?;/g) ?? [])
  .map((statement) => ({
    statement,
    name: statement.match(/CREATE POLICY\s+"([^"]+)"/)?.[1] ?? '',
    table: statement.match(/\sON\s+([\w."]+)/)?.[1] ?? '',
    roles: statement.match(/\bTO\s+([\w,\s]+?)(?:\s+USING|\s+WITH|\s*$)/)?.[1]?.trim() ?? '',
  }))

describe('no anon policy on a data table', () => {
  it('parsed every policy in the schema', () => {
    expect(policyStatements.length).toBeGreaterThan(10)
    for (const p of policyStatements) {
      expect(p.name, p.statement.slice(0, 60)).toBeTruthy()
      expect(p.roles, p.name).toBeTruthy()
    }
  })

  it('grants nothing to anon on any table holding creator or document data', () => {
    // The anon key is public. A single `TO anon` policy on a document table would make
    // every uploaded lecture readable by anyone holding it.
    //
    // realtime.messages is deliberately excluded and deliberately different: anonymous
    // participants MUST receive broadcasts and write presence to play, and migration 0005
    // grants exactly that, scoped to session: topics. That is the transport, not the data.
    for (const p of policyStatements) {
      if (p.table.startsWith('realtime.')) continue
      expect(p.roles, `policy "${p.name}" on ${p.table}`).toBe('authenticated')
    }
  })

  it('confirms realtime is the ONLY place anon is granted anything', () => {
    // If a future migration adds an anon grant somewhere else, this is what notices.
    const withAnon = policyStatements.filter((p) => /\banon\b/.test(p.roles))
    expect(withAnon.map((p) => p.table)).toEqual(['realtime.messages', 'realtime.messages'])
  })

  it('gives the new asset table no anon access of any kind', () => {
    const assetPolicies = policyStatements.filter((p) => p.table === '"document_assets"')
    expect(assetPolicies).toHaveLength(1)
    expect(assetPolicies[0].roles).toBe('authenticated')
  })
})

describe('storage bucket allowlist', () => {
  it('accepts pdf and pptx, and nothing else', () => {
    const update = combined.match(/UPDATE storage\.buckets[\s\S]*?WHERE id = 'documents';/)?.[0] ?? ''
    expect(update).toBeTruthy()
    expect(update).toContain("'application/pdf'")
    expect(update).toContain(
      "'application/vnd.openxmlformats-officedocument.presentationml.presentation'",
    )
    // Storage enforces this list before app code runs. A wildcard here would let any file
    // type into the bucket regardless of what the upload route decided.
    expect(update).not.toContain('*')
    expect(update).not.toMatch(/allowed_mime_types\s*=\s*NULL/i)
  })

  it('keeps the bucket private and the size limit where it was', () => {
    expect(combined).toMatch(/INSERT INTO storage\.buckets[\s\S]*?'documents',\s*false,\s*26214400/)
    // Nothing may flip it public or raise the cap in a later migration.
    expect(combined).not.toMatch(/UPDATE storage\.buckets\s+SET public\s*=\s*true/i)
    expect(combined).not.toMatch(/UPDATE storage\.buckets\s+SET file_size_limit/i)
  })

  it('widens the bucket in a new migration rather than editing the one that created it', () => {
    // 0007 has already been applied. Editing it would leave every existing database on the
    // old definition with no way to notice.
    const creator = allSql.find((m) => m.sql.includes('INSERT INTO storage.buckets'))!
    const widener = allSql.find((m) => m.sql.includes('UPDATE storage.buckets'))!
    expect(creator.file).toBe('0007_busy_scarlet_witch.sql')
    expect(widener.file > creator.file).toBe(true)
  })
})

describe('the immutable source column', () => {
  it('adds ocr_text as a separate nullable column, leaving raw_text alone', () => {
    // raw_text is documented as immutable in schema.ts. OCR output going into it would
    // rewrite what the file actually contained, and shift every existing chunk offset.
    expect(combined).toMatch(/ALTER TABLE "document_pages" ADD COLUMN "ocr_text" text;/)
    expect(combined).not.toMatch(/ALTER TABLE "document_pages"[^;]*(DROP|ALTER) COLUMN "raw_text"/)
    expect(combined).not.toMatch(/UPDATE "?document_pages"?\s+SET\s+raw_text/i)
  })

  it('defaults text_source to digital, so existing rows keep their meaning', () => {
    expect(combined).toMatch(/ADD COLUMN "text_source" text DEFAULT 'digital' NOT NULL/)
  })
})
