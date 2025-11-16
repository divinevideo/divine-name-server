// ABOUTME: Subdomain utility functions
// ABOUTME: Extracts and validates subdomain from hostname

/**
 * Extracts the subdomain from a hostname.
 * Returns the first part of hostname for divine.video domains.
 *
 * @param hostname - The full hostname (e.g., "alice.divine.video")
 * @returns The subdomain (e.g., "alice") or null if not a valid subdomain
 */
export function getSubdomain(hostname: string): string | null {
  const parts = hostname.split('.')
  if (parts.length >= 3 && parts[parts.length - 2] === 'divine' && parts[parts.length - 1] === 'video') {
    return parts[0]
  }
  return null
}
