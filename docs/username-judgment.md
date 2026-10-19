# Optional username judgment

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

## Configuration and failures

The implementation uses Workers AI `@cf/cloudflare/clef`, not Clef Flash.
The deployment owner must separately authorize/configure an `AI` binding and
measured thresholds; this change does not provision a binding or set secrets.

| Setting | Meaning |
| --- | --- |
| `AI` | Workers AI binding |
| `JUDGMENT_BLOCK_MIN` | Measured intent threshold in `(0, 1]`; no default |
| `JUDGMENT_PROPOSE_MIN` | Separately measured, word-only proposal threshold; unset disables proposals |
| `JUDGMENT_MAX_CALLS_PER_MINUTE` | Global database-enforced call budget; default 30; zero disables new calls |

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

Clef thresholds must be measured for the final judged population; old Jev
thresholds and preliminary Clef samples are not release settings. Local Wrangler
AI calls use remote inference and incur usage, but cannot establish deployed
Worker latency. No production latency or accuracy claim is made here.

Before merge, production migrations `0016` and `0017` remain required. Deployment
does not apply them. Production migration/configuration changes and merge require
separate operator authorization. Retire the old TypeSafe settings through that
separately authorized rollout, not by copying their thresholds into the new keys.
