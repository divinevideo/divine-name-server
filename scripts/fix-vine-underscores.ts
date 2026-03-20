#!/usr/bin/env bun
// ABOUTME: Fix Vine usernames with underscores: rename to hyphens and republish kind 0
// ABOUTME: Run with: bun run scripts/fix-vine-underscores.ts [--dry-run] [--skip-kind0]
//
// Prerequisites:
//   1. Access to archived-vines-publisher PostgreSQL (for pubkeys + tokens)
//   2. Keycast admin token (to refresh expired user tokens)
//   3. D1 database access via wrangler
//
// Steps performed:
//   1. Query D1 for usernames containing underscores
//   2. For each affected user, fetch current kind 0 from relays
//   3. Update nip05 field (the_funny_vine -> the-funny-vine)
//   4. Sign via Keycast and publish to relays
//   5. Rename in D1 (via wrangler d1 execute)
//   6. Re-sync Fastly KV

import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

// --- Config ---
const RELAYS = [
  'wss://relay.divine.video',
  'wss://purplepag.es',
  'wss://relay.damus.io',
  'wss://nos.lol',
]
const FETCH_TIMEOUT = 8000
const SIGN_TIMEOUT = 30000

// --- Helpers ---
function loadEnv(filePath: string): Record<string, string> {
  const fullPath = path.resolve(filePath)
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

function normalizeToHyphens(name: string): string {
  return name.replace(/[_.]/g, '-')
}

// Fetch kind 0 for a pubkey from multiple relays
async function fetchKind0(pubkey: string): Promise<any | null> {
  const results: any[] = []

  const promises = RELAYS.map(async (relayUrl) => {
    return new Promise<void>((resolve) => {
      try {
        const ws = new WebSocket(relayUrl)
        const subId = 'k0_' + Math.random().toString(36).slice(2, 8)
        let closed = false
        const timer = setTimeout(() => { if (!closed) { closed = true; ws.close(); resolve() } }, FETCH_TIMEOUT)

        ws.onopen = () => {
          ws.send(JSON.stringify(['REQ', subId, { kinds: [0], authors: [pubkey], limit: 1 }]))
        }
        ws.onmessage = (msg: MessageEvent) => {
          try {
            const data = JSON.parse(String(msg.data))
            if (data[0] === 'EVENT' && data[2]) {
              results.push(data[2])
            }
            if (data[0] === 'EOSE') {
              clearTimeout(timer)
              if (!closed) { closed = true; ws.close(); resolve() }
            }
          } catch {}
        }
        ws.onerror = () => { clearTimeout(timer); if (!closed) { closed = true; ws.close(); resolve() } }
        ws.onclose = () => { clearTimeout(timer); if (!closed) { closed = true; resolve() } }
      } catch {
        resolve()
      }
    })
  })

  await Promise.all(promises)

  if (results.length === 0) return null
  // Return the most recent kind 0
  return results.reduce((best, ev) => (!best || ev.created_at > best.created_at) ? ev : best, null)
}

// Publish a signed event to relays
async function publishToRelays(signedEvent: any): Promise<{ relay: string; ok: boolean; error?: string }[]> {
  const results: { relay: string; ok: boolean; error?: string }[] = []

  const promises = RELAYS.map(async (relayUrl) => {
    return new Promise<void>((resolve) => {
      try {
        const ws = new WebSocket(relayUrl)
        let closed = false
        const timer = setTimeout(() => {
          if (!closed) { closed = true; ws.close(); results.push({ relay: relayUrl, ok: false, error: 'timeout' }); resolve() }
        }, FETCH_TIMEOUT)

        ws.onopen = () => {
          ws.send(JSON.stringify(['EVENT', signedEvent]))
        }
        ws.onmessage = (msg: MessageEvent) => {
          try {
            const data = JSON.parse(String(msg.data))
            if (data[0] === 'OK') {
              clearTimeout(timer)
              results.push({ relay: relayUrl, ok: data[2] === true, error: data[2] === true ? undefined : data[3] })
              if (!closed) { closed = true; ws.close(); resolve() }
            }
          } catch {}
        }
        ws.onerror = () => { clearTimeout(timer); if (!closed) { closed = true; results.push({ relay: relayUrl, ok: false, error: 'ws error' }); resolve() } }
        ws.onclose = () => { clearTimeout(timer); if (!closed) { closed = true; resolve() } }
      } catch (e) {
        results.push({ relay: relayUrl, ok: false, error: String(e) })
        resolve()
      }
    })
  })

  await Promise.all(promises)
  return results
}

// Sign event via Keycast
async function signViaKeycast(keycastUrl: string, userToken: string, unsignedEvent: any): Promise<any> {
  const response = await fetch(`${keycastUrl}/api/nostr`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      method: 'sign_event',
      params: [unsignedEvent],
    }),
    signal: AbortSignal.timeout(SIGN_TIMEOUT),
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Keycast sign failed (${response.status}): ${errorText}`)
  }

  const data = await response.json() as { result: any }
  return data.result
}

// Get fresh token from Keycast admin API
async function getTokenByPubkey(keycastUrl: string, adminToken: string, pubkey: string): Promise<string> {
  const response = await fetch(`${keycastUrl}/api/admin/user-token`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${adminToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ pubkey }),
    signal: AbortSignal.timeout(SIGN_TIMEOUT),
  })

  if (response.status === 404) {
    throw new Error(`User with pubkey ${pubkey.slice(0, 8)}... not found in Keycast`)
  }
  if (response.status === 403) {
    throw new Error(`User with pubkey ${pubkey.slice(0, 8)}... has already claimed their account`)
  }
  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Keycast get-token failed (${response.status}): ${errorText}`)
  }

  const data = await response.json() as { token: string }
  return data.token
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const skipKind0 = args.includes('--skip-kind0')

  console.log('='.repeat(60))
  console.log('  Fix Vine Usernames: Underscores → Hyphens')
  console.log('='.repeat(60))
  if (dryRun) console.log('*** DRY RUN MODE ***')
  if (skipKind0) console.log('*** SKIPPING KIND 0 REPUBLISH ***')
  console.log()

  // Load env from archived-vines-publisher
  const publisherEnvPath = path.resolve(__dirname, '../../archived-vines-publisher/.env')
  let env: Record<string, string>
  try {
    env = loadEnv(publisherEnvPath)
  } catch {
    console.error(`Failed to load .env from archived-vines-publisher`)
    console.error(`Expected at: ${publisherEnvPath}`)
    process.exit(1)
  }

  const keycastUrl = env.KEYCAST_URL
  const adminToken = env.ADMIN_TOKEN
  if (!keycastUrl || !adminToken) {
    console.error('KEYCAST_URL and ADMIN_TOKEN required in archived-vines-publisher .env')
    process.exit(1)
  }

  // Step 1: Query D1 for usernames with underscores
  console.log('Step 1: Finding usernames with underscores in D1...')
  let d1Output: string
  try {
    d1Output = execSync(
      `npx wrangler d1 execute divine-name-server-db --remote --json --command "SELECT id, name, username_canonical, username_display, pubkey, status, relays FROM usernames WHERE (username_canonical LIKE '%\\_%' ESCAPE '\\\\' OR name LIKE '%\\_%' ESCAPE '\\\\') AND status = 'active' AND pubkey IS NOT NULL"`,
      { cwd: path.resolve(__dirname, '..'), encoding: 'utf-8', timeout: 30000 }
    )
  } catch (e) {
    console.error('Failed to query D1. Make sure wrangler is configured.')
    console.error(e)
    process.exit(1)
  }

  let affectedUsers: any[]
  try {
    const parsed = JSON.parse(d1Output)
    affectedUsers = parsed[0]?.results || parsed.results || []
  } catch {
    // Try to extract JSON from output (wrangler sometimes prints extra text)
    const jsonMatch = d1Output.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      affectedUsers = parsed[0]?.results || []
    } else {
      console.error('Failed to parse D1 output:', d1Output.slice(0, 500))
      process.exit(1)
    }
  }

  console.log(`Found ${affectedUsers.length} active users with underscores\n`)

  if (affectedUsers.length === 0) {
    console.log('Nothing to do!')
    return
  }

  // Show what will change
  console.log('Planned changes:')
  for (const u of affectedUsers) {
    const oldName = u.username_canonical || u.name
    const newName = normalizeToHyphens(oldName)
    console.log(`  ${oldName} → ${newName}  (pubkey: ${u.pubkey?.slice(0, 8)}...)`)
  }
  console.log()

  if (dryRun) {
    console.log('DRY RUN complete. No changes made.')
    return
  }

  // Step 2: For each user, update kind 0 via Keycast
  const results: Array<{
    oldName: string
    newName: string
    pubkey: string
    kind0: 'updated' | 'skipped' | 'failed' | 'claimed'
    d1: 'updated' | 'skipped' | 'failed'
    relaysOk?: number
    error?: string
  }> = []

  for (const u of affectedUsers) {
    const oldName = u.username_canonical || u.name
    const newName = normalizeToHyphens(oldName)
    const pubkey = u.pubkey

    console.log(`\nProcessing: ${oldName} → ${newName}`)

    let kind0Status: 'updated' | 'skipped' | 'failed' | 'claimed' = 'skipped'
    let relaysOk = 0

    if (!skipKind0) {
      try {
        // Fetch current kind 0
        console.log(`  Fetching kind 0 for ${pubkey.slice(0, 8)}...`)
        const currentKind0 = await fetchKind0(pubkey)

        let profile: any = {}
        if (currentKind0) {
          try { profile = JSON.parse(currentKind0.content) } catch {}
        }

        // Check if nip05 needs updating
        const oldNip05 = profile.nip05 || ''
        const expectedOldNip05 = `${oldName}@divine.video`
        const newNip05 = `${newName}@divine.video`

        if (oldNip05 === newNip05) {
          console.log(`  NIP-05 already correct: ${newNip05}`)
          kind0Status = 'skipped'
        } else {
          console.log(`  NIP-05: ${oldNip05 || '(none)'} → ${newNip05}`)
          profile.nip05 = newNip05

          // Get fresh signing token from Keycast
          console.log(`  Getting signing token from Keycast...`)
          let token: string
          try {
            token = await getTokenByPubkey(keycastUrl, adminToken, pubkey)
          } catch (e: any) {
            if (e.message?.includes('claimed')) {
              console.log(`  User has claimed their account - cannot sign on their behalf`)
              kind0Status = 'claimed'
              results.push({ oldName, newName, pubkey, kind0: kind0Status, d1: 'skipped' })
              continue
            }
            throw e
          }

          // Build unsigned kind 0 (Keycast requires pubkey in the event)
          const unsignedEvent = {
            pubkey,
            kind: 0,
            created_at: Math.floor(Date.now() / 1000),
            tags: [],
            content: JSON.stringify(profile),
          }

          // Sign via Keycast
          console.log(`  Signing via Keycast...`)
          const signedEvent = await signViaKeycast(keycastUrl, token, unsignedEvent)

          // Publish to relays
          console.log(`  Publishing to ${RELAYS.length} relays...`)
          const pubResults = await publishToRelays(signedEvent)
          relaysOk = pubResults.filter(r => r.ok).length
          const failed = pubResults.filter(r => !r.ok)

          if (relaysOk > 0) {
            console.log(`  Published to ${relaysOk}/${RELAYS.length} relays`)
            kind0Status = 'updated'
          } else {
            console.log(`  Failed to publish to any relay`)
            for (const f of failed) console.log(`    ${f.relay}: ${f.error}`)
            kind0Status = 'failed'
          }
        }
      } catch (e) {
        console.error(`  Kind 0 update failed: ${e}`)
        kind0Status = 'failed'
      }
    }

    // Step 3: Rename in D1
    let d1Status: 'updated' | 'skipped' | 'failed' = 'skipped'
    try {
      const now = Math.floor(Date.now() / 1000)
      const newDisplay = u.username_display ? normalizeToHyphens(u.username_display) : newName
      const sql = `UPDATE usernames SET name = '${newName}', username_canonical = '${newName}', username_display = '${newDisplay}', updated_at = ${now} WHERE id = ${u.id}`

      console.log(`  Updating D1: ${oldName} → ${newName}`)
      execSync(
        `npx wrangler d1 execute divine-name-server-db --remote --command "${sql}"`,
        { cwd: path.resolve(__dirname, '..'), encoding: 'utf-8', timeout: 15000 }
      )
      d1Status = 'updated'
    } catch (e) {
      console.error(`  D1 update failed: ${e}`)
      d1Status = 'failed'
    }

    results.push({ oldName, newName, pubkey, kind0: kind0Status, d1: d1Status, relaysOk })
  }

  // Summary
  console.log('\n' + '='.repeat(60))
  console.log('  Results Summary')
  console.log('='.repeat(60))
  console.log()

  const kind0Updated = results.filter(r => r.kind0 === 'updated').length
  const kind0Claimed = results.filter(r => r.kind0 === 'claimed').length
  const kind0Failed = results.filter(r => r.kind0 === 'failed').length
  const d1Updated = results.filter(r => r.d1 === 'updated').length
  const d1Failed = results.filter(r => r.d1 === 'failed').length

  console.log(`Total users processed: ${results.length}`)
  console.log(`Kind 0 updated: ${kind0Updated}, claimed (skipped): ${kind0Claimed}, failed: ${kind0Failed}`)
  console.log(`D1 renamed: ${d1Updated}, failed: ${d1Failed}`)
  console.log()

  for (const r of results) {
    const k0 = r.kind0 === 'updated' ? `kind0 ✓ (${r.relaysOk} relays)` :
               r.kind0 === 'claimed' ? 'kind0 CLAIMED' :
               r.kind0 === 'failed' ? 'kind0 FAILED' : 'kind0 skipped'
    const d1 = r.d1 === 'updated' ? 'd1 ✓' : r.d1 === 'failed' ? 'd1 FAILED' : 'd1 skipped'
    console.log(`  ${r.oldName} → ${r.newName}  [${k0}] [${d1}]`)
  }

  if (kind0Claimed > 0) {
    console.log(`\nNote: ${kind0Claimed} user(s) have claimed their accounts.`)
    console.log('They need to update their kind 0 NIP-05 manually in their Nostr client.')
    console.log('Claimed users:')
    for (const r of results.filter(r => r.kind0 === 'claimed')) {
      console.log(`  ${r.oldName} → ${r.newName}  (pubkey: ${r.pubkey.slice(0, 16)}...)`)
    }
  }

  console.log('\nNext steps:')
  console.log('  1. Run Fastly sync: POST /api/admin/sync/fastly')
  console.log('  2. Verify NIP-05 resolution for renamed users')
  if (kind0Claimed > 0) {
    console.log('  3. Contact claimed users to update their NIP-05 in their client')
  }
}

main().catch(e => {
  console.error('Fatal error:', e)
  process.exit(1)
})
