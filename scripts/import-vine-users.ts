#!/usr/bin/env bun
// ABOUTME: Import Vine users from PostgreSQL into D1 for NIP-05 verification
// ABOUTME: Also syncs to Fastly KV for edge routing
// ABOUTME: Run with: bun run scripts/import-vine-users.ts [--dry-run] [--limit=N] [--skip-fastly]

import { execSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import pg from 'pg'

const FASTLY_API_BASE = 'https://api.fastly.com'

// Parse .env file
function loadEnv(filePath: string): Record<string, string> {
  const fullPath = path.resolve(import.meta.dir, filePath)
  if (!fs.existsSync(fullPath)) {
    throw new Error(`Env file not found: ${fullPath}`)
  }
  const envFile = fs.readFileSync(fullPath, 'utf-8')
  const env: Record<string, string> = {}
  for (const line of envFile.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/)
    if (match) {
      env[match[1].trim()] = match[2].trim().replace(/^["']|["']$/g, '')
    }
  }
  return env
}

// Sanitize username for NIP-05 (lowercase alphanumeric, dots, underscores, hyphens)
function sanitizeForNip05(username: string): string {
  if (!username) return ''
  return username
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9._-]/g, '')    // Keep only allowed chars
    .replace(/^[._-]+|[._-]+$/g, '') // Trim dots/underscores/hyphens from ends
    .slice(0, 63)                     // Max 63 chars (DNS label limit)
}

// Sync to Fastly KV
async function syncToFastly(
  apiToken: string,
  storeId: string,
  username: string,
  pubkey: string,
  relays: string[] = []
): Promise<boolean> {
  const kvKey = `user:${username}`
  const url = `${FASTLY_API_BASE}/resources/stores/kv/${storeId}/keys/${encodeURIComponent(kvKey)}`

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Fastly-Key': apiToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pubkey, relays, status: 'active' }),
    })

    if (!response.ok) {
      console.error(`  Fastly sync failed for ${username}: ${response.status}`)
      return false
    }
    return true
  } catch (error) {
    console.error(`  Fastly sync error for ${username}:`, error)
    return false
  }
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const skipFastly = args.includes('--skip-fastly')
  const limitArg = args.find(a => a.startsWith('--limit='))?.split('=')[1]
  const limit = limitArg ? parseInt(limitArg, 10) : undefined

  console.log('='.repeat(60))
  console.log('  Import Vine Users to D1 for NIP-05')
  console.log('='.repeat(60))
  if (dryRun) console.log('*** DRY RUN MODE ***')
  if (skipFastly) console.log('*** SKIPPING FASTLY SYNC ***')
  console.log()

  // Load PostgreSQL connection from archived-vines-publisher
  let env: Record<string, string>
  try {
    env = loadEnv('../../archived-vines-publisher/.env')
  } catch (e) {
    console.error('Failed to load .env from archived-vines-publisher')
    console.error('Make sure ../../archived-vines-publisher/.env exists')
    process.exit(1)
  }

  const pgUrl = env.POSTGRES_URL || env.DATABASE_URL
  if (!pgUrl) {
    console.error('No POSTGRES_URL or DATABASE_URL found in .env')
    process.exit(1)
  }

  // Fastly credentials
  const fastlyToken = env.FASTLY_API_TOKEN
  const fastlyStoreId = env.FASTLY_STORE_ID

  if (!skipFastly && (!fastlyToken || !fastlyStoreId)) {
    console.warn('Warning: FASTLY_API_TOKEN or FASTLY_STORE_ID not found')
    console.warn('Fastly sync will be skipped. Use --skip-fastly to suppress this warning.\n')
  }

  // Connect to PostgreSQL
  console.log('Connecting to PostgreSQL...')
  const client = new pg.Client({ connectionString: pgUrl })
  await client.connect()

  // Query imported users with their vanity URLs
  const query = `
    SELECT
      i.vine_user_id,
      i.username,
      i.pubkey,
      u.vanity_urls
    FROM imported_users i
    LEFT JOIN users u ON i.vine_user_id = u.user_id
    WHERE i.pubkey IS NOT NULL
    ORDER BY i.vine_user_id
    ${limit ? `LIMIT ${limit}` : ''}
  `

  const result = await client.query(query)
  console.log(`Found ${result.rows.length} imported users with pubkeys\n`)
  await client.end()

  // Process users and compute NIP-05 names
  const assignments: Array<{ name: string; pubkey: string; display: string }> = []

  for (const row of result.rows) {
    let nip05Name = sanitizeForNip05(row.username)
    let displayName = row.username

    // Prefer vanity URL if available
    if (row.vanity_urls) {
      try {
        const vanities = typeof row.vanity_urls === 'string'
          ? JSON.parse(row.vanity_urls)
          : row.vanity_urls
        if (Array.isArray(vanities) && vanities.length > 0) {
          nip05Name = sanitizeForNip05(vanities[0])
          displayName = vanities[0]
        }
      } catch {
        // Invalid vanity_urls, use sanitized username
      }
    }

    // Fallback for empty names
    if (!nip05Name) {
      nip05Name = `vine_${row.vine_user_id}`
      displayName = `vine_${row.vine_user_id}`
    }

    assignments.push({
      name: nip05Name,
      pubkey: row.pubkey,
      display: displayName
    })
  }

  console.log(`Prepared ${assignments.length} username assignments\n`)

  // Show sample
  console.log('Sample assignments:')
  for (const a of assignments.slice(0, 5)) {
    console.log(`  ${a.name} (${a.display}) -> ${a.pubkey.slice(0, 8)}...`)
  }
  if (assignments.length > 5) {
    console.log(`  ... and ${assignments.length - 5} more`)
  }
  console.log()

  if (dryRun) {
    console.log('DRY RUN - no changes made')
    console.log(`Would insert ${assignments.length} usernames into D1`)
    if (!skipFastly && fastlyToken && fastlyStoreId) {
      console.log(`Would sync ${assignments.length} usernames to Fastly KV`)
    }
    return
  }

  // Generate SQL statements for D1
  const now = Math.floor(Date.now() / 1000)
  const sqlStatements: string[] = []

  for (const a of assignments) {
    const canonical = a.name.toLowerCase()
    const escaped = (s: string) => s.replace(/'/g, "''")

    sqlStatements.push(
      `INSERT INTO usernames (name, username_display, username_canonical, pubkey, status, created_at, updated_at, claimed_at) ` +
      `VALUES ('${escaped(canonical)}', '${escaped(a.display)}', '${escaped(canonical)}', '${a.pubkey}', 'active', ${now}, ${now}, ${now}) ` +
      `ON CONFLICT(username_canonical) DO UPDATE SET ` +
      `pubkey = '${a.pubkey}', username_display = '${escaped(a.display)}', status = 'active', updated_at = ${now}, claimed_at = ${now}`
    )
  }

  // Write SQL to temp file
  const sqlFile = '/tmp/vine-users-import.sql'
  fs.writeFileSync(sqlFile, sqlStatements.join(';\n') + ';')
  console.log(`Generated SQL file: ${sqlFile}`)
  console.log(`Total statements: ${sqlStatements.length}\n`)

  // Execute via wrangler
  console.log('Executing via wrangler d1 execute...')
  try {
    const scriptDir = import.meta.dir
    execSync(`cd ${scriptDir}/.. && npx wrangler d1 execute divine-name-server-db --remote --file=${sqlFile}`, {
      stdio: 'inherit'
    })
    console.log('\nD1 import complete!')
  } catch (e) {
    console.error('\nFailed to execute SQL via wrangler')
    console.error('You can manually run:')
    console.error(`  cd divine-name-server && npx wrangler d1 execute divine-name-server-db --remote --file=${sqlFile}`)
    process.exit(1)
  }

  // Sync to Fastly KV
  if (!skipFastly && fastlyToken && fastlyStoreId) {
    console.log('\nSyncing to Fastly KV...')
    let fastlySuccess = 0
    let fastlyFailed = 0

    for (let i = 0; i < assignments.length; i++) {
      const a = assignments[i]
      const success = await syncToFastly(fastlyToken, fastlyStoreId, a.name, a.pubkey)
      if (success) {
        fastlySuccess++
      } else {
        fastlyFailed++
      }

      // Progress update every 100
      if ((i + 1) % 100 === 0 || i === assignments.length - 1) {
        console.log(`  Progress: ${i + 1}/${assignments.length} (${fastlySuccess} ok, ${fastlyFailed} failed)`)
      }
    }

    console.log(`\nFastly sync complete: ${fastlySuccess} succeeded, ${fastlyFailed} failed`)
  }

  console.log('\nAll done!')
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
