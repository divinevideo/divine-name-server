// ABOUTME: Derives the name to import for an archived Vine creator.
// ABOUTME: Kept free of I/O so the Bun import script stays thin and this stays testable.

export interface ImportRow {
  vine_user_id: number | string
  username: string | null
  pubkey: string
  vanity_urls: unknown
}

/** The creator's first vanity URL when the archive has one, otherwise their username. */
function sourceName(row: ImportRow): string {
  let name = row.username ?? ''
  if (row.vanity_urls) {
    try {
      const vanities = typeof row.vanity_urls === 'string' ? JSON.parse(row.vanity_urls) : row.vanity_urls
      if (Array.isArray(vanities) && typeof vanities[0] === 'string') name = vanities[0]
    } catch {
      // Invalid archived vanity JSON retains the original username fallback.
    }
  }
  return name
}

/**
 * Turn a source name into a DNS-label-safe one: accents stripped, anything else
 * outside letters, digits and hyphens becomes a hyphen. Case is kept on purpose:
 * the server stores the name as sent for display and lowercases only the canonical
 * form, so lowercasing here would drop the creator's casing from their profile.
 */
export function deriveImportName(row: ImportRow): string {
  return sourceName(row).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 63).replace(/^-+|-+$/g, '') || `vine-${row.vine_user_id}`
}
