#!/usr/bin/env bun
// ABOUTME: Imports archived users through the name server's ownership-checked API.
// ABOUTME: Credentials must be injected by a credential manager; defaults to dry-run.
import pg from 'pg'
import { importName } from '../src/utils/import-client'
import { deriveImportName } from '../src/utils/vine-import'

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg) && !/^--limit=\d+$/.test(arg))) {
    throw new Error('Usage: bun scripts/import-vine-users.ts [--apply | --dry-run] [--limit=N]')
  }
  if (args.includes('--apply') && args.includes('--dry-run')) throw new Error('Choose apply or dry-run')
  const apply = args.includes('--apply')
  const limitArg = args.find(arg => arg.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('Invalid limit')
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL
  const serverUrl = process.env.NAME_SERVER_URL
  const token = process.env.USERNAME_IMPORT_TOKEN
  if (!databaseUrl) throw new Error('Inject POSTGRES_URL or DATABASE_URL')
  if (apply && (!serverUrl || !token)) throw new Error('Inject NAME_SERVER_URL and USERNAME_IMPORT_TOKEN for apply')
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  let rows
  try {
    const result = await client.query(`
      SELECT i.vine_user_id, i.username, i.pubkey, u.vanity_urls
      FROM imported_users i LEFT JOIN users u ON i.vine_user_id = u.user_id
      WHERE i.pubkey IS NOT NULL ORDER BY i.vine_user_id
      ${limit === null ? '' : 'LIMIT $1'}
    `, limit === null ? [] : [limit])
    rows = result.rows
  } finally {
    await client.end()
  }
  let inserted = 0
  let conflicts = 0
  let invalid = 0
  for (const row of rows) {
    if (apply) {
      const outcome = await importName(serverUrl!, token!, { name: deriveImportName(row), pubkey: row.pubkey })
      if (outcome === 'inserted') inserted++
      else if (outcome === 'conflict') conflicts++
      else invalid++
    }
  }
  console.log(JSON.stringify({ dry_run: !apply, candidates: rows.length, inserted, conflicts, invalid }))
}

main().catch(error => {
  // Only emit the controlled status-code error, never driver/provider text
  // which can contain source data or connection credentials.
  const message = error instanceof Error && /^Name import failed: HTTP \d{3}$/.test(error.message)
    ? error.message : 'Import failed; check inputs and service availability before retrying'
  console.error(message)
  process.exitCode = 1
})
