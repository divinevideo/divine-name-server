#!/usr/bin/env bun
// ABOUTME: Imports archived users through the name server's ownership-checked API.
// ABOUTME: Credentials must be injected by a credential manager; defaults to dry-run.
import pg from 'pg'
import { describeImportFailure, importName, importUrl, ImportUsageError } from '../src/utils/import-client'
import { importRows, type ImportRow } from '../src/utils/vine-import'

async function main() {
  const args = process.argv.slice(2)
  if (args.some(arg => !['--apply', '--dry-run'].includes(arg) && !/^--limit=\d+$/.test(arg))) {
    throw new ImportUsageError('Usage: bun scripts/import-vine-users.ts [--apply | --dry-run] [--limit=N]')
  }
  if (args.includes('--apply') && args.includes('--dry-run')) throw new ImportUsageError('Choose apply or dry-run')
  const apply = args.includes('--apply')
  const limitArg = args.find(arg => arg.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : null
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new ImportUsageError('Invalid limit')
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL
  const serverUrl = process.env.NAME_SERVER_URL
  const token = process.env.USERNAME_IMPORT_TOKEN
  if (!databaseUrl) throw new ImportUsageError('Inject POSTGRES_URL or DATABASE_URL')
  if (apply && (!serverUrl || !token)) throw new ImportUsageError('Inject NAME_SERVER_URL and USERNAME_IMPORT_TOKEN for apply')
  if (apply) importUrl(serverUrl!) // a bad URL is a usage error, reported before the archive is read
  const client = new pg.Client({ connectionString: databaseUrl })
  await client.connect()
  let rows: ImportRow[]
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
  if (!apply) {
    // Nothing is sent in a dry run, so there are no outcome counts to report.
    console.log(JSON.stringify({ dry_run: true, candidates: rows.length }))
    return
  }
  const { counts, processed, error } = await importRows(rows, assignment => importName(serverUrl!, token!, assignment))
  // Counts are printed even when the run stops, so an operator can see what was
  // already imported. A re-run starts from the first candidate and counts those
  // names as conflicts.
  console.log(JSON.stringify({ dry_run: false, candidates: rows.length, processed, ...counts, stopped: error !== undefined }))
  if (error !== undefined) throw error
}

main().catch(error => {
  console.error(describeImportFailure(error))
  process.exitCode = 1
})
