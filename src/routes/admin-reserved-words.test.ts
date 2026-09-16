// ABOUTME: Tests for the admin reserved-words endpoints
// ABOUTME: Ensures the blocklist accepts exactly the names the username namespace can produce

import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import admin from './admin'
import { validateUsername } from '../utils/validation'
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

function deleteWord(db: D1Database, word: string) {
  const req = new Request(`http://localhost/admin/reserved-words/${encodeURIComponent(word)}`, {
    method: 'DELETE',
  })
  return createTestApp().fetch(req, { DB: db, BYPASS_LOCAL_AUTH: 'true' }, createExecutionContext())
}

function storedWord(calls: { sql: string; params: unknown[] }[]) {
  return calls.find(c => c.sql.includes('INSERT INTO reserved_words'))?.params[0]
}

describe('POST /admin/reserved-words', () => {
  // The invariant the bug violated. Stated as a property rather than a list of
  // cases so a future charset change to validateUsername cannot silently leave
  // the blocklist behind again.
  describe('accepts every form the username namespace can produce', () => {
    const registerable = [
      'plainword',
      'go-fuck-yourself',   // the reported case: hyphens, multiple segments
      'a-b',                // minimal hyphenation
      'name123',            // digits
      'Mixed-Case',         // uppercase, canonicalized on the way in
      'café',               // Unicode, canonicalized to punycode
      'a'.repeat(55),       // longer than the old 50-char cap, still registerable
    ]

    for (const name of registerable) {
      it(`accepts ${JSON.stringify(name)}`, async () => {
        // Guard the premise: if validateUsername ever stops accepting this,
        // the test is asserting the wrong thing and should fail loudly here.
        const expected = validateUsername(name).canonical

        const { db, calls } = createCapturingDB()
        const res = await addWord(db, { word: name, category: 'profanity' })

        expect(res.status).toBe(200)
        expect(storedWord(calls)).toBe(expected)
      })
    }
  })

  it('stores the canonical form, so the row matches what a claim is compared against', async () => {
    // isReservedWord compares a claim's canonical form. A Unicode term stored in
    // its display form would sit in the table looking correct and match nothing.
    const { db, calls } = createCapturingDB()
    const res = await addWord(db, { word: 'café', category: 'profanity' })

    expect(res.status).toBe(200)
    expect(storedWord(calls)).toBe('xn--caf-dma')
    expect(storedWord(calls)).not.toBe('café')
  })

  it('rejects a word that could never be registered, using the validator message', async () => {
    // Edge hyphens are unregisterable, so blocking them would be meaningless.
    const { db, calls } = createCapturingDB()
    const res = await addWord(db, { word: '-leading', category: 'profanity' })

    expect(res.status).toBe(400)
    const json = await res.json() as { ok: boolean; error: string }
    expect(json.ok).toBe(false)
    expect(json.error).toBe("Usernames can't start or end with a hyphen")
    expect(storedWord(calls)).toBeUndefined()
  })

  it('rejects hyphens at the punycode-reserved positions', async () => {
    const { db, calls } = createCapturingDB()
    const res = await addWord(db, { word: 'ab--cd', category: 'profanity' })

    expect(res.status).toBe(400)
    // Assert the message, not just the status: the old charset rule also
    // rejected this input, so status alone cannot tell the two rules apart.
    const json = await res.json() as { error: string }
    expect(json.error).toBe('Usernames cannot have hyphens at positions 3 and 4')
    expect(storedWord(calls)).toBeUndefined()
  })

  it('still requires word and category', async () => {
    const { db, calls } = createCapturingDB()

    expect((await addWord(db, { category: 'profanity' })).status).toBe(400)
    expect((await addWord(db, { word: 'plainword' })).status).toBe(400)
    expect(storedWord(calls)).toBeUndefined()
  })

  it('rejects a non-string word with 400 rather than failing inside the validator', async () => {
    const { db, calls } = createCapturingDB()
    const res = await addWord(db, { word: 123, category: 'profanity' })

    expect(res.status).toBe(400)
    expect(storedWord(calls)).toBeUndefined()
  })
})

describe('DELETE /admin/reserved-words/:word', () => {
  function deletedForms(calls: { sql: string; params: unknown[] }[]) {
    return calls.find(c => c.sql.includes('DELETE FROM reserved_words'))?.params ?? []
  }

  it('removes a row that would not pass validation today', async () => {
    // Rows added under the old rule must stay removable, so DELETE must not
    // require the word to validate. Requiring it would strand exactly the bad
    // entries an admin most needs to clear.
    const { db, calls } = createCapturingDB()
    const res = await deleteWord(db, '-leading')

    expect(res.status).toBe(200)
    expect(deletedForms(calls)).toContain('-leading')
  })

  it('removes a Unicode row stored in its canonical form', async () => {
    // POST stores café as xn--caf-dma, so deleting by what the admin typed has
    // to reach the canonical row too, or the delete silently no-ops.
    const { db, calls } = createCapturingDB()
    const res = await deleteWord(db, 'café')

    expect(res.status).toBe(200)
    expect(deletedForms(calls)).toContain('xn--caf-dma')
  })
})
