// ABOUTME: Tests for operational runbook coverage that protects critical sync paths

import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

describe('Fastly automation token runbook', () => {
  it('documents token creation, secret rotation, verification, and cleanup decisions', () => {
    const runbookPath = resolve(process.cwd(), 'docs/runbooks/fastly-automation-token.md')

    expect(existsSync(runbookPath)).toBe(true)

    const content = readFileSync(runbookPath, 'utf-8')

    expect(content).toContain('global scope')
    expect(content).toContain('all services')
    expect(content).toContain('no expiration')
    expect(content).toContain('npx wrangler secret put FASTLY_API_TOKEN')
    expect(content).toContain('POST /api/admin/sync/fastly')
    expect(content).toContain('hourly cron')
    expect(content).toContain('divine-name-sync')
  })

  it('documents FASTLY_STORE_ID as a checked-in var and warns about stale secret shadowing', () => {
    const runbookPath = resolve(process.cwd(), 'docs/runbooks/fastly-automation-token.md')

    expect(existsSync(runbookPath)).toBe(true)

    const content = readFileSync(runbookPath, 'utf-8')

    expect(content).toContain('`FASTLY_API_TOKEN` is the only secret being rotated')
    expect(content).toContain('`FASTLY_STORE_ID` is checked in as a `[vars]` resource identifier')
    expect(content).toContain('a `FASTLY_STORE_ID` secret shadows the checked-in `[vars]` value')
    expect(content).toContain('npx wrangler secret delete FASTLY_STORE_ID')
  })
})
