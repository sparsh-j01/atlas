// Nickname guard for the anonymous join. Pure, client+server safe — the same rules run in
// the browser for instant feedback and again on the server, which is the one that counts.
//
// Why this exists at all: a nickname typed by a stranger goes straight onto a projector at
// the front of a classroom, and there is no signup to trace it back to. It is the most
// predictable thing that goes wrong at a live demo.
//
// This is a filter, not a solution. Any wordlist is beatable by someone who wants to beat
// it, which is exactly why it ships together with a host kick control (POST
// /api/sessions/{code}/kick) — the filter handles volume, the host handles the misses.
//
// ponytail: hand-rolled normalize + substring list, no dependency. It catches lazy
// obfuscation (leetspeak, padding, repeats, punctuation), not a determined adversary. The
// upgrade path, if this ever needs to be real, is a maintained matcher like `obscenity`
// (it does confusable-character folding and whitelist-aware boundaries properly). Not worth
// the supply-chain surface here: the kick button is what actually makes misses survivable.

export const NICKNAME_MAX = 24

// Folded to a letter so `n1gg`, `$hit`, `f-u-c-k` collapse onto the same string as the plain
// spelling. Digits map to what they imitate, not to their value.
const CONFUSABLES: Record<string, string> = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '6': 'g', '7': 't', '8': 'b', '9': 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '(': 'c', '<': 'c',
}

/**
 * Squash a nickname down to the string the wordlist is matched against: lowercase, accents
 * stripped, lookalikes folded, everything non-alphabetic dropped, runs of a repeated letter
 * collapsed. `Ｆ　U　C　K`, `f.u.c.k`, `fuuuuck` and `f4ck` all land on the same six letters.
 *
 * Deliberately lossy and NOT what gets stored — `sanitizeNickname` decides what is stored.
 */
export function foldForMatch(s: string): string {
  return s
    .normalize('NFKD') // fullwidth → ascii, and accents split off their base letter
    .replace(/[̀-ͯ]/g, '') // drop the split-off accents
    .toLowerCase()
    .replace(/[^a-z0-9@$!|+(<]/g, '') // keep letters and the symbols we fold below
    .replace(/[0-9@$!|+(<]/g, (c) => CONFUSABLES[c] ?? '')
    .replace(/(.)\1+/g, '$1') // fuuuck → fuck
}

// Matched as substrings of the folded string, so anything that folds onto one of these is
// caught however it was padded or spelled. Kept SHORT and specific for that reason: a
// substring list makes innocent words collide (the Scunthorpe problem), so entries have to
// be strings that do not appear inside ordinary words. Anything milder than this is the
// host's judgement call, which is what the kick button is for.
//
// Written in plain spelling and folded at load, NOT stored pre-folded: `foldForMatch`
// collapses repeats, so a literal 'nigger' here would never match a folded input (which is
// 'niger'). Folding both sides is the only way the two stay in step — and it's why the list
// avoids words whose folded form collides with an ordinary one ('boob' folds to 'bob', which
// would reject every Bob in the room; 'spic' sits inside 'spice').
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'wank', 'bastard',
  'nigger', 'nigga', 'faggot', 'retard', 'tranny', 'chink', 'kike',
  'rape', 'nazi', 'hitler', 'penis', 'vagina', 'dick', 'cock',
  'pedo', 'kys',
].map(foldForMatch)

/** True when the nickname folds onto something in the blocklist. */
export function isBlockedNickname(nickname: string): boolean {
  const folded = foldForMatch(nickname)
  return BLOCKED.some((w) => folded.includes(w))
}

export type NicknameCheck = { ok: true; nickname: string } | { ok: false; error: string }

/**
 * The join boundary's whole nickname rule, in one call. Returns the exact string to store,
 * or the message to show the player.
 *
 * Collapses internal whitespace as well as trimming: a name padded with spaces or built out
 * of zero-width characters renders as a blank row on the projector, which is its own kind of
 * griefing. Length is checked AFTER that, so padding can't buy extra characters.
 */
export function sanitizeNickname(raw: unknown): NicknameCheck {
  if (typeof raw !== 'string') return { ok: false, error: 'nickname is required' }
  const nickname = raw
    .replace(/[​-‏‪-‮⁠﻿]/g, '') // zero-width + directional marks
    .replace(/\s+/g, ' ')
    .trim()
  if (!nickname) return { ok: false, error: 'Pick a nickname.' }
  if (nickname.length > NICKNAME_MAX)
    return { ok: false, error: `Nicknames are ${NICKNAME_MAX} characters or fewer.` }
  // No reason given, deliberately: naming the matched word turns the error into an oracle
  // for probing the list.
  if (isBlockedNickname(nickname)) return { ok: false, error: 'Pick a different nickname.' }
  return { ok: true, nickname }
}
