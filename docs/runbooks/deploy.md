# Deploying the name server

Merging to `main` deploys the Worker by itself. Migrations are not automated.
That asymmetry is the thing this runbook exists for: the automated half is the
half that breaks when the manual half has not been done first.

## The rule

**Apply migrations before merging. Never after.**

`.github/workflows/deploy.yml` runs on every push to `main`. It runs the test
workflow as a gate, then `wrangler deploy`. Nothing in it applies migrations, and
nothing checks whether unapplied ones exist.

So if a change reads a column or table that a migration creates, and the code
deploys first, the affected routes fail in production until someone runs the
migration by hand. There is no red check and no alert. It looks like a working
deploy.

Applying first is normally safe, because a migration that adds columns with
defaults or adds tables is invisible to the code already running. That is a claim
to check, not an assumption. The check is below.

### Confirming a migration is invisible to the running code

Adding columns and tables is safe. Writing rows is not automatically safe, because
the code already in production may read that table.

List what each pending migration actually does:

```bash
rg -o '^(ALTER TABLE|INSERT OR IGNORE INTO|INSERT INTO|UPDATE|CREATE TABLE|CREATE INDEX|DELETE)' migrations/00XX_*.sql | sort | uniq -c
```

`ALTER TABLE` adding a column, `CREATE TABLE` and `CREATE INDEX` are invisible to
the running code. For anything that writes rows, work out which table and whether
the live code reads it.

For an insert into a table the live code reads, check whether the rows are already
there. An `INSERT OR IGNORE` whose keys all exist is a no-op and safe; one that
adds a genuinely new row changes behaviour immediately, before the code that was
meant to accompany it. Pull the keys out of the migration and compare them against
production:

```bash
npx wrangler d1 execute divine-name-server-db --remote --json \
  --command "SELECT word FROM reserved_words" > /tmp/prod-rows.json
```

Then diff the two sets. Zero new rows means the insert is inert and the ordering
does not matter for it. Any new rows mean you are changing production behaviour at
the moment you apply, so decide whether that is acceptable on its own.

An `UPDATE` that only writes columns the same migration just added is invisible.
An `UPDATE` touching an existing column is not.

## Before you merge

Run these from a checkout of the branch you are about to merge, not from `main`.
Migrations are resolved from the files on disk, so the checkout decides what gets
applied.

1. See what would be applied, and read the list.

   ```bash
   npx wrangler d1 migrations list divine-name-server-db --remote
   ```

   Expect exactly the migrations your change adds. If anything else appears, stop
   and find out why before continuing.

   The list prints newest first, which is not the order they will be applied in.
   Seeing `0017` above `0016` is normal. Wrangler applies them in numeric order.

2. Record the state you are changing, so you can tell afterwards whether it did
   what you expected.

   ```bash
   npx wrangler d1 execute divine-name-server-db --remote \
     --command "SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 3"
   ```

3. Apply them.

   ```bash
   npx wrangler d1 migrations apply divine-name-server-db --remote
   ```

   While it runs, the status table may show a clock against a migration that has
   not finished yet. That is progress, not a failure. Read the final table.

4. Verify against the database rather than trusting the command's output. Query
   the things the migration was supposed to change, in one statement, so you get
   a single row you can compare against what you recorded in step 2.

   ```bash
   npx wrangler d1 execute divine-name-server-db --remote --json --command "
     SELECT (SELECT name FROM d1_migrations ORDER BY id DESC LIMIT 1) AS last_migration,
            (SELECT COUNT(*) FROM reserved_words) AS words"
   ```

   Extend the select with whatever the migration touched: a new column's
   distribution, a new table's row count, a version counter. Check the numbers
   you predicted, including the ones you predicted would not move.

## Merge

Merge the pull request. The deploy runs on its own.

Watch it finish rather than assuming it did:

```bash
gh run list --repo divinevideo/divine-name-server --workflow deploy.yml --limit 1
```

## After the deploy

Check behaviour through the public API, not the row counts you already looked at.
A migration can land and a deploy can go green while the feature does nothing.

```bash
curl -s https://names.divine.video/api/username/check/<a-name-you-expect-blocked>
curl -s https://names.divine.video/api/username/check/<a-name-you-expect-free>
```

Test both directions. A change that blocks everything passes a one-sided check.

## Configuration that must be set separately

Some features are inert until configuration exists, and inert can mean refusing
rather than allowing. A deploy will not tell you.

- Variables set in the Cloudflare dashboard are wiped by the next deploy, because
  `keep_vars` is off. Put them in `wrangler.toml`, or set them with
  `wrangler secret put` if they are secret.
- After deploying a change that adds configuration, confirm the behaviour that
  depends on it, not just that the deploy succeeded.

## Credentials

Use the credential manager rather than a token on disk:

```bash
credchain cloudflare-divine npx wrangler ...
```

One trap: `wrangler` prefers `CLOUDFLARE_API_TOKEN` from the environment over a
stored OAuth login. If a wrapper injects that variable and the token lacks a
scope the command needs, you get an authentication error even though
`wrangler whoami` looks healthy. For anything needing a scope the API token does
not carry, run `wrangler` unwrapped so it uses the OAuth session.

## If the order went wrong

If code deployed before its migrations, the fix is to apply them immediately. The
routes recover as soon as the schema exists; no redeploy is needed. Check the
affected endpoints afterwards.

Do not roll back the Worker to fix a missing migration. That leaves two moving
parts instead of one.
