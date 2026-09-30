// ABOUTME: The importer has no Fastly credentials or direct KV/D1 write path.
export async function importName(serverUrl: string, token: string, assignment: { name: string; pubkey: string }): Promise<'inserted' | 'conflict' | 'invalid'> {
  const url = new URL('/api/internal/username/import', serverUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('Name server must use HTTPS or local HTTP')
  }
  const response = await fetch(url, {
    method: 'POST', redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(assignment),
  })
  if (response.status === 409) return 'conflict'
  if (response.status === 400) return 'invalid'
  if (response.status !== 201) throw new Error(`Name import failed: HTTP ${response.status}`)
  return 'inserted'
}
