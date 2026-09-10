/**
 * The handful of facts the two legal documents need that are not derivable from the code.
 * Swap them here once and both pages update.
 *
 * ponytail: plain consts, not env vars — these change when the company is registered,
 * not per deploy. Grep for "[" to find what is still a placeholder.
 */
export const ENTITY = 'Sparsh Jhunjhunwala'
export const CONTACT_EMAIL = '[contact@example.com]'
export const GRIEVANCE_OFFICER = 'Sparsh Jhunjhunwala'
export const POSTAL_ADDRESS = '[REGISTERED ADDRESS]'
export const JURISDICTION = '[CITY]'
export const SITE_URL = '[SITE URL]'

/** Bump both when either document changes materially. */
export const LAST_UPDATED = '4 September 2026'
