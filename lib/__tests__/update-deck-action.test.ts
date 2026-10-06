import { describe, it, expect, vi } from 'vitest'

// updateDeckAction's patch is client input. Spread into the update, `{ ownerId }` gave the
// deck to another creator and `{ status: 'ready' }` skipped the ready gate (2026-10-05 fuzz,
// checks I12a/I12b). Only title and description may reach data.updateDeck.
const updateDeck = vi.fn(async () => {})
vi.mock('@/lib/auth', () => ({ requireUser: async () => ({ id: 'owner-a' }) }))
vi.mock('@/lib/decks', () => ({ updateDeck }))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/headers', () => ({ cookies: async () => ({}) }))
vi.mock('next/navigation', () => ({ redirect: () => {} }))
vi.mock('@/lib/supabase/server', () => ({}))
vi.mock('@/lib/sessions', () => ({}))
vi.mock('@/lib/documents', () => ({}))

const { updateDeckAction } = await import('@/lib/actions')

describe('updateDeckAction', () => {
  it('passes only title and description, never owner or status', async () => {
    const hostile = { title: 'T', ownerId: 'owner-b', owner_id: 'owner-b', status: 'ready', shareToken: 'x', id: 'y' }
    await updateDeckAction('deck-1', hostile as never)
    expect(updateDeck).toHaveBeenLastCalledWith('deck-1', 'owner-a', { title: 'T' })

    await updateDeckAction('deck-1', { status: 'ready' } as never)
    expect(updateDeck).toHaveBeenLastCalledWith('deck-1', 'owner-a', {})
  })

  it('keeps the existing cleanup: blank title falls back, NUL dropped, null description clears', async () => {
    await updateDeckAction('deck-1', { title: ' \0 ', description: null })
    expect(updateDeck).toHaveBeenLastCalledWith('deck-1', 'owner-a', { title: 'Untitled deck', description: null })
    await updateDeckAction('deck-1', { description: 'a\0b' })
    expect(updateDeck).toHaveBeenLastCalledWith('deck-1', 'owner-a', { description: 'ab' })
  })
})
