// ABOUTME: Tests for the admin reserved-words endpoints
// ABOUTME: Ensures the blocklist accepts exactly the names the username namespace can produce

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import admin from './admin'
import { createExecutionContext } from '../db/test-helpers'

// Captures what actually reaches SQL so we can assert the stored form, not just
// the HTTP status. The route, validateUsername and addReservedWord all run for
// real; only the D1 driver is stubbed.
function createCapturingDB() {
  const calls: { sql: string; params: unknown[] }[] = []
  const result = {
    run: async () => ({ success: true }),
    first: async () => null,
    all: async () => ({ results: [] }),
  }
  const db = {
    prepare(sql: string) {
      return {
        bind: (...params: unknown[]) => {
          calls.push({ sql, params })
          return result
        },
        ...result,
      }
    },
  } as unknown as D1Database
  return { db, calls }
}

function createTestApp() {
  const app = new Hono<{ Bindings: { DB: D1Database; BYPASS_LOCAL_AUTH?: string } }>()
  app.route('/admin', admin)
  return app
}

function addWord(db: D1Database, body: unknown) {
  const req = new Request('http://localhost/admin/reserved-words', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return createTestApp().fetch(req, { DB: db, BYPASS_LOCAL_AUTH: 'true' }, createExecutionContext())
}

function storedWord(calls: { sql: string; params: unknown[] }[]) {
  return calls.find(c => c.sql.includes('INSERT INTO reserved_words'))?.params[0]
}

describe('POST /admin/reserved-words', () => {
  it('accepts a hyphenated word, because hyphenated names are registerable', async () => {
    const { db, calls } = createCapturingDB()
    const res = await addWord(db, { word: 'go-fuck-yourself', category: 'profanity' })

    expect(res.status).toBe(200)
    expect(storedWord(calls)).toBe('go-fuck-yourself')
  })
})
