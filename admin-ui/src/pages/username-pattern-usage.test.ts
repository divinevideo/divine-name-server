// ABOUTME: Guards against the recurrence vector behind #89/#92 — a form hardcoding
// ABOUTME: its own username pattern instead of importing the shared constant

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pagesDir = dirname(fileURLToPath(import.meta.url))

/**
 * True if the source hardcodes a `pattern` attribute as a string literal in any
 * JSX spelling — `pattern="..."`, `pattern='...'`, `pattern={"..."}`,
 * `pattern={'...'}`, or `` pattern={`...`} ``. The only allowed form is
 * `pattern={IDENT}` (i.e. the shared constant), where the char after `{` is an
 * identifier, not a quote or backtick.
 *
 * Every historical form bug (#89, #92) was a form carrying its own pattern
 * literal that drifted from the real rule; this keeps the rule in one constant.
 * The lookbehind stops an unrelated attribute like `data-pattern="..."` from
 * tripping it — a plain `\b` would not, since the hyphen is itself a word
 * boundary. It does not chase a literal buried in a larger expression
 * (`pattern={cond ? "x" : "y"}`) — that is not the recurrence vector and no form
 * would write it.
 */
export function hasHardcodedPattern(src: string): boolean {
  return /(?<![-\w])pattern\s*=\s*\{?\s*[`"']/.test(src)
}

describe('hasHardcodedPattern detector', () => {
  // The detector is the load-bearing part; test it against every spelling
  // directly, since a hole here silently disarms the sweep below.
  it.each([
    ['double quote', 'pattern="[a-z0-9]+"'],
    ['single quote', "pattern='[a-z0-9]+'"],
    ['brace + double quote', 'pattern={"[a-z0-9]+"}'],
    ['brace + single quote', "pattern={'[a-z0-9]+'}"],
    ['brace + backtick', 'pattern={`[a-z0-9]+`}'],
    ['spaces around equals', 'pattern = "[a-z0-9]+"'],
    ['space after brace', 'pattern={ "[a-z0-9]+" }'],
  ])('flags a hardcoded pattern: %s', (_label, sample) => {
    expect(hasHardcodedPattern(sample)).toBe(true)
  })

  it.each([
    ['the shared constant', 'pattern={USERNAME_INPUT_PATTERN}'],
    ['no pattern attribute at all', 'value={name} required'],
    ['an unrelated attribute ending in pattern', 'data-pattern="ignored"'],
  ])('allows %s', (_label, sample) => {
    expect(hasHardcodedPattern(sample)).toBe(false)
  })
})

describe('admin form pattern usage', () => {
  const pages = readdirSync(pagesDir).filter(f => f.endsWith('.tsx'))

  it('finds the form pages to check (guards against an empty sweep)', () => {
    expect(pages.length).toBeGreaterThan(0)
  })

  it('no page under src/pages hardcodes a username pattern', () => {
    const offenders = pages.filter(page =>
      hasHardcodedPattern(readFileSync(join(pagesDir, page), 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
