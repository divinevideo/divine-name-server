// ABOUTME: The importer has no Fastly credentials or direct KV/D1 write path.
// ABOUTME: Its errors carry fixed text only, so the script can print them safely.

/** A mistake in how the importer was invoked or configured. */
export class ImportUsageError extends Error {}

/** The name server could not complete a request. */
export class ImportServiceError extends Error {}

// A hung connection would otherwise stall a run of thousands of sequential requests.
const REQUEST_TIMEOUT_MS = 30_000

/**
 * The import endpoint of a name server. Refuses anything that would send the
 * token over remote plaintext HTTP. The script calls this before it reads the
 * archive, so a bad URL is reported before any request is made.
 */
export function importUrl(serverUrl: string): URL {
  let url: URL
  try {
    url = new URL('/api/internal/username/import', serverUrl)
  } catch {
    throw new ImportUsageError('NAME_SERVER_URL is not a valid URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new ImportUsageError('Name server must use HTTPS or local HTTP')
  }
  return url
}

export async function importName(serverUrl: string, token: string, assignment: { name: string; pubkey: string }): Promise<'inserted' | 'conflict' | 'invalid'> {
  const url = importUrl(serverUrl)
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(assignment),
    })
  } catch {
    // The transport error can name the host and address; the operator needs only
    // to know that nothing answered.
    throw new ImportServiceError('Name import failed: no response from the name server')
  }
  if (response.status === 409) return 'conflict'
  if (response.status === 400) return 'invalid'
  if (response.status !== 201) throw new ImportServiceError(`Name import failed: HTTP ${response.status}`)
  return 'inserted'
}

/**
 * The message the script may print for a failure. Only the importer's own fixed
 * text gets through: driver and provider errors can contain source data or
 * connection credentials.
 */
export function describeImportFailure(error: unknown): string {
  if (error instanceof ImportUsageError || error instanceof ImportServiceError) return error.message
  return 'Import failed; check inputs and service availability before retrying'
}
