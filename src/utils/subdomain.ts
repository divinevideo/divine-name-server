// ABOUTME: Subdomain utility functions
// ABOUTME: Extracts and validates subdomain from hostname

/**
 * Extracts the subdomain from a hostname.
 * Returns the first part of hostname for single-level divine.video subdomains.
 * Multi-level subdomains (e.g., names.admin.divine.video) return null.
 *
 * @param hostname - The full hostname (e.g., "alice.divine.video")
 * @returns The subdomain (e.g., "alice") or null if not a valid subdomain
 */
export function getSubdomain(hostname: string): string | null {
  const parts = hostname.split('.')
  if (parts.length === 3 && parts[1] === 'divine' && parts[2] === 'video') {
    return parts[0]
  }
  return null
}
