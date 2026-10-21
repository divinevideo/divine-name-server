# Username matching and judgment

Reserved words block whole names or separate words according to their stored
scope. Approving a suggested word makes it a separate-word block, not an
automatic substring block. Hidden uses can still require judgment.

Digit-for-letter substitution is enabled for existing and new words; the old
per-row `match_leet` value no longer disables it. Numeric terms retain their
separate, existing digit-expansion rules. This can change matching for existing
rows. No registered-name examples are included here.

Content words with at least four matched characters can trigger judgment when
hidden inside a longer username. Stored separators do not count toward four.
This includes the slur category. Shorter words still block under their stored
scope, but never trigger a hidden-word judgment. Host/product categories remain
scope-only.

## Prepared configuration

The implementation uses Workers AI `@cf/cloudflare/clef`, not Clef Flash.
The checked-in Wrangler configuration prepares an `AI` binding and the string
`JUDGMENT_BLOCK_MIN = "0.60"`. When that configuration is later deployed, it
enforces the threshold immediately. Preparing these files does not activate the
running Worker, and deployment/merge still require separate authorization.
There is no observe-only mode.

| Setting | Meaning |
| --- | --- |
| `AI` | Workers AI binding |
| `JUDGMENT_BLOCK_MIN` | Intent threshold in `(0, 1]`; prepared starting value `0.60`, no runtime fallback |
| `JUDGMENT_PROPOSE_MIN` | Separate word-only proposal threshold; unset disables proposals |
| `JUDGMENT_MAX_CALLS_PER_MINUTE` | Global database-enforced call budget; default 30; zero disables new calls |

Nonsecret threshold values belong in `wrangler.toml`, not dashboard variables:
`keep_vars` is off, so deploy overwrites dashboard variables. An existing secret
with the same name can shadow a variable; the operator must verify effective
configuration during the separately authorized rollout, without displaying or
copying credentials. This change does not alter secrets or add a proposal
threshold; proposal generation remains separately configured.

## Deliberate starting-threshold trade

`0.60` is an unvalidated starting policy, not a calibrated operating point or a
claim of deployed accuracy. Available small local samples do not establish the
production false-refusal rate, and scores from the previous provider do not
transfer to Clef.

Some legitimate names will be refused on a threshold that has not yet been
measured on deployed traffic. The expected number is small, the affected person
sees an unavailable name rather than anything irreversible, and the score data
makes it correctable quickly. That is a deliberate trade, not an oversight.
The expectation of a small number is not a deployed measurement or guarantee.
Use authorized deployed aggregate evidence and feedback to revise the starting
number; no production calibration is claimed here.

## Existing two states and failures

An absent binding or absent/empty block threshold disables the second layer:
ambiguous names are clear, while deterministic blocks remain in force. This is
not the same as a configured layer failing. Invalid configured thresholds,
binding failures, invalid answers, eight-second timeouts and exhausted budget
refuse the ambiguous name. Failed judgments are never cached. Invalid configured
budgets permit no new calls. A timeout is not retried or refunded; the binding
does not expose a documented cancellation option.

Public `/check` and normal reservation resolution use the same judgment and
cache, with no per-IP judgment allowance. Every complete verdict is cached by
canonical name, blocklist version and model/question/threshold policy. A blocklist
edit invalidates old verdicts. Existing unrelated request protections remain.

The invite-reservation path retains its existing no-spend behavior pending a
separate route decision. It can reuse a cached verdict but refuses an uncached
ambiguous name when the second layer is configured. This change does not add a
faucet validation or redemption route.

## Retained scores and aggregate readout

Each newly judged cached verdict retains the highest score among its completed
intent calls. A blocked name stops at the first score meeting the threshold;
that triggering score is retained. A clear name includes all of its embedded
terms. This is the maximum **observed** score, not a claim that unasked questions
were evaluated. Proposal scores concern a different question and are not mixed
into the name's score.

Existing cached rows keep a nullable score. They remain usable without inventing
scores or spending another model call. New failures, partial judgments and
unconfigured passes produce no cached verdict or score.

`GET /api/admin/judgment-stats` uses the existing admin hostname, Cloudflare Access
or authorized Keycast-session boundary. It returns counts grouped by policy,
verdict and score ranges for the blocklist version selected at the start of the
read, with legacy unscored counts. Ranges are half-open except the highest range
includes `1.0`. It returns no individual name, raw score or name/score pairs;
the public username-check response is unchanged. There is no new admin UI.

The same response includes the current and preceding 59 minute buckets of
**reserved call attempts**. These counters include intent/proposal attempts and
failed calls, not confirmed model successes, unique people or measured billing.
Cached-verdict counts are entries, not unique names across different policies.
Score distributions cover retained entries for that version, not only that hour.
Unlabelled distributions cannot establish a false-positive rate on their own.
Responses are marked `Cache-Control: no-store`.

## Rollout order

Production migrations `0016`, `0017` and the new additive `0018` must be applied
before merging/deploying code that depends on them. Deployment does not apply
migrations. Follow [the deploy runbook](runbooks/deploy.md), verifying which are
already applied rather than blindly reapplying or inferring from a green deploy.

`0018` adds only a nullable column and an index: no row writes, cache-key changes,
verdict changes or backfill. Old explicit-column cache reads/writes remain valid.
This additive compatibility is exercised locally; no production migration is
applied by this preparation. Actual migration, publication, deployment, activation
and configuration effects require their separate authorization. Local Wrangler
AI inference is remote and billable; local proxy timings are not deployed Worker
latency, and no production latency or accuracy claim is made here.
