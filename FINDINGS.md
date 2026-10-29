# Findings

## Ops issues

### What was broken

1. **Dockerfiles missing.** `ops/docker-compose.yml` builds every app service from
   `ops/Dockerfile.node` or `ops/Dockerfile.go`. Neither exists in the working tree or in any
   commit, branch, tag, reflog entry or dangling object, so they were never committed despite
   the README/compose comments. (No 2-byte `Dockerfile.node` was present in this checkout either.)
2. **settlement exits at boot.** `settlement daemon` requires `SETTLEMENT_INTERNAL_TOKEN`
   (`apps/settlement/internal/config/config.go`, `RequireInternalToken`); there is no `dev-token`
   default as compose/README claim. Compose didn't set it.
3. **api and seed exit at boot.** The built-in dev `WEBHOOK_SECRET_ENCRYPTION_KEY` fallback in
   `apps/api/src/config.ts` decodes to 34 bytes and fails the app's own 32-byte check, so the key
   is required in every environment. `seed` loads the api config, so it fails the same way.
4. **No startup ordering.** migrate, seed and all services started as soon as Postgres was
   healthy; seed and reporting ran against an empty schema.
5. **`ops/.env.docker` is never loaded** (not changed). Compose has no `env_file:`, so
   `NODE_ENV=production` and `ACQUIRER_CALLBACK_SIGNING_SECRET` never reach any container; the api
   runs with `NODE_ENV` unset (development). The file is also committed: see **F-3**.
6. **Migrations fail on a fresh DB.** 0054 and 0055 abort `migrate`; see **F-1** and **F-2**
   (fixed). The numbering gaps 0039, 0041, 0059, 0062, 0063 and 0067 were never in git.

### What changed

- `ops/Dockerfile.node`: `node:22-bookworm-slim`, full `npm ci` workspace install (services run via
  tsx, a devDependency), runs as `node`, writable `data/kyc` for KYC uploads. Node 22, not the
  README's 20, because `cookie@2.0.1` (via `@fastify/cookie`) requires node >=22.
- `ops/Dockerfile.go`: `golang:1.24` build with `CGO_ENABLED=0`, distroless static `nonroot`
  runtime, binary at `/app/settlement` to match compose's `./settlement daemon`.
- `ops/Dockerfile.{node,go}.dockerignore`: per-Dockerfile ignore files so host `node_modules`,
  `.git` and `.env` files stay out of the build context.
- `ops/docker-compose.yml`:
  - Passes `SETTLEMENT_INTERNAL_TOKEN` to settlement and api.
  - Passes `WEBHOOK_SECRET_ENCRYPTION_KEY` to api and seed.
  - Both use `${VAR:?}` interpolation, with no baked-in defaults.
  - seed, api, settlement and reporting now wait for `migrate` to complete successfully.
  - Replaced the two comments that described those variables incorrectly.
- `ops/.env` (local only, gitignored, untracked): randomly generated values for those two
  variables.
- `db/migrations/0054_views.sql`, `0055_chart_of_accounts_suspense.sql`: fixed in place (F-1, F-2).
- `.gitignore`: added `audit/`.

### State after changes

`docker compose down -v && docker compose up -d` on a fresh volume:
- migrate exits 0 with all 66 migrations applied.
- seed exits 0 (all REAL assertions pass).
- api, settlement and reporting are up with no errors in their logs.
- api `/healthz` and `/readyz` return 200.

Images must be rebuilt (`docker compose build`) after migration changes, because `db/` is copied
into the image.

## Findings

### F-1: 0054 references a table that does not exist (`settlement_batch_events`)

- **What's wrong.** `v_unbatched_capture_events` in `db/migrations/0054_views.sql` filtered with
  `NOT EXISTS (SELECT 1 FROM settlement_batch_events …)`. No migration creates that table, and no
  Go or TS code reads or writes it.
- **Why.** Batch membership is `transaction_events.settlement_batch_id` (0023: NULL means
  "eligible for the next batch"). That is the predicate `apps/settlement/internal/settlement/batch.go`
  (CloseBatch) and `apps/api/src/settlement/query.ts` use. The view was written against a model the
  schema never had.
- **What breaks.**
  - `migrate` aborts on every fresh database, so seed never runs and the services start against a
    partial schema.
  - The same migration also creates `merchant_payable_position`, which
    `apps/settlement/internal/ledger/refresh.go` (balance rebuild) queries, so that path fails too.
- **Fix (applied).** Replace the subquery with `te.settlement_batch_id IS NULL`, edited in place.
  - Creating the table instead would leave it permanently empty, since nothing writes it, so the view
    would report every capture as unbatched forever.
  - In place, not a later migration: the runner aborts at the first failure, so nothing numbered
    after 0054 can rescue a fresh database.
  - The runner tracks filenames only. There is no checksum, despite the comment in `db/migrate.ts`,
    so databases that already recorded 0054 are unaffected.
- **Not fixed.** The view keeps `event_type = 'captured'`, while the code treats
  `('captured', 'partially_captured')` as batchable. Nothing reads the view today.

### F-2: 0055 inserts into columns `chart_of_accounts` does not have

- **What's wrong.** `0055_chart_of_accounts_suspense.sql` inserted
  `(code, name, account_type, description)` with `account_type = 'suspense'` and
  `ON CONFLICT (code)`.
  - The table (0007) is `(id, name, kind)` with `kind IN ('asset','liability','revenue')`.
  - 0061, 0064 and all code (`ledger_entries.account_id → chart_of_accounts.id`) use that shape.
  - Nothing reads `code`, `account_type` or `description`.
- **Why.** The migration was written against a different chart-of-accounts schema than the one in
  this repo.
- **What breaks.** `migrate` aborts on a fresh DB once F-1 is fixed, with the same knock-on effects.
- **Fix (applied).** Insert the two accounts as `(id, name, kind)` with `kind = 'asset'` and
  `ON CONFLICT (id)`, edited in place for the same reasons as F-1.
  - Suspense accounts are `asset`, following 0007's `scheme_rounding_residue`.
  - The descriptions moved into SQL comments.
  - Adding the missing columns, or a `'suspense'` kind, would be schema no code uses.

### F-3: Acquirer callback signing secret committed in `ops/.env.docker`

- **What's wrong.** `ops/.env.docker` holds `ACQUIRER_CALLBACK_SIGNING_SECRET=acqsec_sandbox_…`
  and has been tracked since the bootstrap commit 669af52 (2025-08-03).
  - Its comments say it is gitignored "like .env". It is not: the `.env` pattern matches only files
    named exactly `.env`.
  - It says the value was "rotated in July after the b64cd3c commit". There is no commit b64cd3c,
    and the value has never changed in history.
- **Why it matters.** The secret authenticates acquirer callbacks
  (`apps/api/src/routes/acquirerCallbacks.ts`). Anyone with read access to the repo or a clone can
  sign forged callbacks for any environment that uses this value. The "sandbox only" label is
  unverified.
- **What breaks.** Nothing at runtime. The file is never loaded (Ops issue 5), so currently no
  container receives the secret at all.
  - Related, not yet investigated: `ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaults to `false`.
- **Fix (not applied).**
  1. Treat the value as compromised and rotate it with the acquirer.
  2. `git rm --cached ops/.env.docker`.
  3. Add `.env.*` with `!.env.example` to `.gitignore`, and commit an example file without values.
  4. Pass the secret via an untracked env file or secret store, wired explicitly with `env_file:`.
  5. Optionally purge it from history (`git filter-repo`); rotation is what actually closes the
     exposure.
