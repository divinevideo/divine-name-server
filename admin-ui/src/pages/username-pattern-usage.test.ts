// ABOUTME: Guards against the recurrence vector behind #89/#92 — a form hardcoding
// ABOUTME: its own username pattern instead of importing the shared constant

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pagesDir = dirname(fileURLToPath(import.meta.url))

// Every historical form bug (#89, #92) was a form carrying its own `pattern`
// literal that drifted from the real rule. The fix put the rule in one constant;
// this keeps it that way. A form's pattern must come from USERNAME_INPUT_PATTERN,
// never a string literal, so it cannot silently diverge again.
describe('admin form pattern usage', () => {
  const pages = readdirSync(pagesDir).filter(f => f.endsWith('.tsx'))

  it('finds the form pages to check (guards against an empty sweep)', () => {
    expect(pages.length).toBeGreaterThan(0)
  })

  it.each(['Reserve.tsx', 'Assign.tsx', 'Revoke.tsx', 'ReservedWords.tsx'])(
    '%s does not hardcode a pattern attribute',
    (page) => {
      const src = readFileSync(join(pagesDir, page), 'utf8')
      // A literal `pattern="..."` or `pattern={'...'}` is the drift we forbid;
      // `pattern={USERNAME_INPUT_PATTERN}` is the allowed form.
      expect(src).not.toMatch(/pattern\s*=\s*["'{]\s*["'[]/)
    },
  )

  it('no page under src/pages carries a literal pattern attribute', () => {
    const offenders = pages.filter(page => {
      const src = readFileSync(join(pagesDir, page), 'utf8')
      return /pattern\s*=\s*["']/.test(src)
    })
    expect(offenders).toEqual([])
  })
})
