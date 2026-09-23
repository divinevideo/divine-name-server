# Reserved-word matching that resists respellings

Design for divinevideo/divine-name-server#91.

## Problem

The reserved-words blocklist matches exact whole strings. `isReservedWord`
(`src/db/queries.ts`) is `SELECT 1 FROM reserved_words WHERE word = ?`, called
with a claim's canonical form from the check, reserve, and claim paths
(`src/routes/username.ts:89,254,520`). So a listed term is blocked only when it
is the entire name, standing alone.

Verified against production: with `fuck` reserved, the claim check still reports
`f-u-c-k`, `fu-ck`, and `fuck1` as available, and multi-segment names built from
a listed term are registerable, and several are live. The bypass space
is generative — separators, trailing digits, and repeated characters produce
arbitrarily many spellings of any listed term — so no amount of enumerating
entries closes it. Matching has to normalise before comparing.

#89 made the blocklist able to *hold* hyphenated terms (charset alignment). This
issue is the other half: making it *match* the respellings.

## The hard constraint

A legitimate name that merely contains a shorter listed term as a substring must
stay registerable, in any spelling that normalises to it. Refusing a real
person's name at signup is a worse failure than the one being fixed, and it is
invisible because the rejected user simply leaves. Collateral substring blocking
is a defect, not a tuning dial.

This design satisfies that constraint **by construction**, not by tuning: no
match mode can match a term mid-word (see Match modes), so a legit word that
contains a shorter term can never be blocked as a side effect.

## Scope

**In:** ASCII respellings of listed terms — separators, trailing/embedded digits,
repeated characters, case. This is where every reported bypass lives.

**Out, and why:**

- **Unicode / cross-script confusables** (`mаtt` with a Cyrillic а) — a different
  transform (UTS-39 skeleton) on a different axis. That is #48. This design
  builds the normalisation *pipeline* so #48 extends it rather than growing a
  second one, but does not implement confusable folding.
- **Leetspeak letter substitution** (`1`→`l`, `3`→`e`, `4`→`a`). No reported
  bypass uses it, and letter-mapping is where false-positive risk and complexity
  concentrate. Deferred; the normaliser is structured to accept it later as one
  more pipeline step.
- **Routing matches to human review** instead of blocking. No review queue
  exists; a larger build.

## Match modes

Every `reserved_words` entry carries a `match_mode`. Two modes, both matching a
**whole normalised unit** — never a substring:

| mode | matches when | example (`term = fuck`) |
|---|---|---|
| `exact` | the whole name normalises to the term | `f-u-c-k`, `fuck1` → normalise to `fuck` → blocked; `starfucker` → allowed |
| `token` | any hyphen-separated segment of the name normalises to the term | `zq-fuck-zq` → segment `fuck` → blocked; `fuck-you` → blocked; `starfucker` → allowed |

`token` is a superset of `exact` for a single-segment name (the whole name is its
only segment), so `token` is the mode for a term that also appears in compounds.
`exact` is the conservative default.

There is deliberately **no `substring` mode.** A substring match is the only
thing that could block a legit word as collateral, so omitting it makes the hard
constraint a property of the design rather than something tests must police. The
residual cost — a term jammed into one word with no separator (no reported case)
— is handled by listing that specific compound as its own `exact` entry.

### The punycode boundary

The matcher receives the canonical form, which for a Unicode name is punycode
(`café` → `xn--caf-dma`). Those hyphens are structural, not separators, so
token-splitting punycode on hyphens would mangle it. Therefore:

- A name beginning `xn--` is matched with `exact` only — never token-split.
- Every other name is token-split on hyphens as normal.

The rule keys on the `xn--` prefix, not on "is it ASCII" — `xn--caf-dma` is
itself ASCII, so an is-ASCII test would still mangle it. A literal user-typed
`xn--…` name (the charset permits the ACE prefix) is rare and simply forgoes
token coverage, which is acceptable. This is consistent with scope: ASCII
respellings are #91; the Unicode axis is #48.

## Normalisation

`normalizeForMatch(s: string): string`, a pure, total function (never throws),
applied identically to both sides of every comparison:

1. NFKC (fold compatibility variants)
2. casefold (lowercase)
3. strip separators (`-`; defensively also `_ .` though the username charset
   already excludes them)
4. strip ASCII digits
5. collapse a run of the same character to one

This is the minimal set that closes the reported bypasses. Each step is
independent, so #48 adds its confusable/script steps to the same pipeline.

Worked example: `F-U-U-C-K-1` → NFKC/casefold `f-u-u-c-k-1` → strip separators
`fuuck1` → strip digits `fuuck` → collapse runs `fuck`.

> Note on collapse-runs: it also folds a legitimately doubled letter, so a term
> and a name differing only by letter doubling collide. Accepted — the collision
> is between a name and a *listed term*, never incidental, and doubling is a
> common evasion. Called out so it is a known property, not a surprise.

## Components and data flow

```
username check / reserve / claim
        │  (already funnel through one function)
        ▼
  validateUsername → canonical
        ▼
  isReservedWord(db, canonical)              src/db/queries.ts
        │  load all reserved_words rows (tiny table)
        │  normName = normalizeForMatch(canonical)
        │  for each row:
        │    exact:  normName === normalizeForMatch(row.word)
        │    token:  ASCII name only → any normalise(segment) === normalizeForMatch(row.word)
        ▼
  boolean
```

- **Matcher** (`src/db/queries.ts` `isReservedWord`): rewritten from a SQL point
  lookup to an in-memory match over the full table. The three call sites are
  untouched — rewriting this one function is what "check, reserve, and claim
  share one matching implementation" requires. Loading dozens of rows per check
  is acceptable; a comment records the row-count threshold (low thousands) beyond
  which a normalised-column index would be worth it.
- **Normaliser** (`src/matching/normalize.ts`, new): the pure pipeline above,
  plus a `segments(name)` helper for token mode.
- **Write path** (`addReservedWord`, `POST /admin/reserved-words`): accept an
  optional `match_mode`, validated against the allowed set, default `exact`.
- **Admin UI** (`ReservedWords.tsx`): a mode selector on the add form, defaulting
  to `exact`. Small, and the admin-ui test setup from #94 covers it.

## Schema

A new migration file — this repo manages D1 schema through numbered files in
`migrations/` applied with `wrangler d1 migrations apply` (there is no runtime
`ensureSchema`). Latest is `0013`, so:

```sql
-- migrations/0014_add_match_mode.sql
ALTER TABLE reserved_words ADD COLUMN match_mode TEXT NOT NULL DEFAULT 'exact';
```

The migration must be applied to the staging and production D1 (`wrangler d1
migrations apply divine-name-server-db`) as its own deploy step; there is no
migrate script wired into `npm run deploy`, so the plan calls it out explicitly.

Every existing row (the ~35 seeded system/brand/protocol terms plus any
moderator additions) defaults to `exact`, so **behaviour on deploy is identical
to today** — nothing newly blocked until a term is deliberately set to `token`.
The normalised term is computed at load, not stored: one source of truth (the
normalise function), and the table is small enough that recomputation is free.

## Error handling

`normalizeForMatch` is total. The matcher's DB load propagates errors as the
current `isReservedWord` does. Worth naming: a failed load currently means the
check throws (the caller surfaces an error) rather than silently allowing a
reserved name; this design keeps that. It does not introduce a fail-open path.

## Existing entries

Left at `exact` (the default). Pre-classifying the seeded profanity terms into
`token` is a data/policy call this PR deliberately does not make — moderators opt
a term up when they want compound coverage. Flagged so the absence is a decision,
not an omission.

## Testing

- **Normaliser units** — each step, and the worked composition; total on empty /
  edge input.
- **Matcher, exact** — a name and its separator/digit/case/repeat respellings all
  match a listed term; an unrelated name does not.
- **Matcher, token** — a listed term blocks it standing alone, as a hyphen
  segment, and in its respellings; a compound that merely *contains* the term as
  a substring (not a whole segment) is **allowed** — the hard-constraint proof.
- **Punycode** — an `xn--` name is matched exact-only; token-splitting is not
  applied to it.
- **Neutral fixtures throughout** — e.g. term `spam`: block `spam`, `s-p-a-m`,
  `spam1`, `go-spam-yours`; allow `spamalot`. No profane examples in the repo.
- **Mutation-verified** — reverting the matcher to exact-string turns the respell
  tests red; removing the token path turns the segment tests red; a mode set to
  the wrong value fails.
- **Shared path** — one test asserts all three route call sites go through the
  rewritten matcher (e.g. a `token` entry blocks a respelling on check, reserve,
  and claim alike).

## Acceptance criteria (from #91)

- [x] matched when part of a longer name → `token` mode (whole segment)
- [x] separator and digit substitution do not defeat a listed term → normaliser
- [x] a legit name containing a shorter term as a substring stays registerable →
  no `substring` mode; guaranteed by construction
- [x] false-positive posture documented in code + covered by neutral-fixture
  tests
- [x] check/reserve/claim share one matcher → the rewritten `isReservedWord`
- [x] mutation-verified tests
- [x] normaliser exposed for reuse by #48 → `src/matching/normalize.ts` pipeline

## Not in scope

Retroactive sweep of already-registered names the new rules would catch —
revoking a live username is a moderation action with its own notice/appeal
questions; tracked separately. The affected list stays in the T&S working
context, not this public repo.
