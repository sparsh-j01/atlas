import { isUuid } from './ids'

/**
 * The storage object a document row may make the service role touch, or null.
 *
 * `documents.storage_path` can't be trusted on its own: RLS lets an authenticated owner
 * UPDATE their own row through the public API, so a creator could point it at another
 * creator's file and have the service role download it (into their own document) or delete
 * it. The only path a row may claim is the one the upload route builds from that row's own
 * owner, hash and type.
 */
export function documentStoragePath(doc: {
  ownerId: string
  contentHash: string
  sourceType: string
  storagePath: string
}): string | null {
  if (!isUuid(doc.ownerId) || !/^[a-f0-9]{64}$/.test(doc.contentHash) || !['pdf', 'pptx'].includes(doc.sourceType))
    return null
  const expected = `${doc.ownerId}/${doc.contentHash}.${doc.sourceType}`
  return doc.storagePath === expected ? expected : null
}
