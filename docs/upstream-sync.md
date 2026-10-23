# Keeping the fork in sync with upstream

This fork (`aol-tech/mike`) carries the Avenia CLM features — pipeline, radar,
dossier, contract terms, acervo, and the Notion/Drive/Calendar mirrors — on
top of `open-legal-products/mike`. All of that code lives in
`backend/src/modules/contracts/`, three mirror files in `backend/src/lib/`
(`notion.ts`, `drive.ts`, `gcal.ts`, plus `google.ts`), the CLM pages under
`frontend/src/app/(pages)/{pipeline,radar,acervo}` and the project
`dossier`/`review` tabs, and migrations named `20260808_*` and
`20261020_9x_*`. Keeping it there is what keeps merges small.

## The weekly routine

`.github/workflows/upstream-sync.yml` runs every Monday (and on demand):

- clean merge → pushes `sync/upstream-<date>` and opens a **draft PR** listing
  the new upstream migrations;
- conflicting merge → opens an **issue** listing the conflicted files.

A PR or push made with the workflow's `GITHUB_TOKEN` triggers no other
workflow, but a `workflow_dispatch` it sends does (hence `actions: write`).
So after opening the PR the routine dispatches, on the sync branch,
`ci.yml`, `schema-drift.yml`, `docker-images.yml`, `stack-tests.yml`,
`e2e.yml` and `word-addin.yml`; their checks land on the PR's head SHA.
`desktop.yml`, `security.yml` (dependency audit), `gitleaks.yml` and CodeQL
listen to `pull_request` only: close and reopen the PR in the UI to run them
before marking it ready. No personal access token is used, by decision.

## Merging by hand

```bash
git fetch upstream
git checkout -b sync/upstream-$(date +%Y-%m-%d) main
git merge --no-ff upstream/main      # merge, never rebase: main is shared
```

Resolution rules that held in the 2026-10 sync:

- Adopt upstream's abstractions (modules + facades, `StorageAdapter`,
  `checkProjectAccess`, the LLM provider registry) and move our code onto
  them, rather than keeping a parallel copy.
- `backend/schema.sql` must end with every migration file in the
  `schema_migrations` list; a new migration takes an unused `YYYYMMDD_NN`
  slot (see `migrationLedger.test.ts`). Fork migrations use sequence `90`–`99`
  of their day: upstream numbers from `01` up and claimed a slot of ours
  twice before this rule.
- A fork migration is folded into `schema.sql` in the same commit, including
  grants: a table created after the "Direct client grant hardening" section
  needs its own `grant ... to service_role` in the migration (CI's
  schema-drift job and the desktop upgrade test both compare the two paths).
- New `app.ts` mounts need their path segments in the Sentry route
  vocabulary (`sentryPrivacy.ts`, identical in frontend and backend).

Then run, from the repository root:

```bash
npm ci --prefix backend && npm ci --prefix frontend
npm test --prefix backend && npm run build --prefix backend
npm run typecheck --prefix frontend && npm run lint --prefix frontend
npm test --prefix frontend && npm run build --prefix frontend
```

A shell that exports `ANTHROPIC_BASE_URL` (Claude Code behind a proxy does)
fails three `providers.catalog` tests; run the suite with
`env -u ANTHROPIC_BASE_URL`.

## Running a local stack beside production data

The production volumes on the maintainer's machine belong to the Compose
project `mike` (`mike_db_data`, `mike_storage_data`). Never start this
checkout under that project name, and do not use `scripts/stack.sh` there: its
`gc` sweeps stopped projects whose name starts with `mike`. Use another
project name and ports:

```bash
docker compose -p mikesync --env-file <ports.env> \
  -f docker-compose.yml -f <override-with-other-image-tags.yml> up -d --build
```

On a machine running many Compose projects Docker can fail with "all
predefined address pools have been fully subnetted"; give the override an
explicit `networks.default.ipam.config: [{subnet: 10.231.0.0/24}]`.

Smoke test: sign up, confirm the email in Mailpit, log in, then `GET
/pipeline`, `PATCH /pipeline/:projectId`, `PUT /projects/:id/dossier` (body
`{"payload": {...}}`) and `POST /obligations` should succeed; the LLM paths
(`/projects/:id/terms/extract`, `/acervo`) return `model_required` until a
model is chosen in Settings.

## Production database

The production deployment (see the deploy repo) has no `db-init` service and
no `schema_migrations` ledger: migrations were applied by hand. Before the
first deploy of a synced build:

1. Back up the database volume.
2. Apply, in filename order, every migration the database has not run.
   Compare the directory with the schema (tables/columns) — the fork's own
   `20260808_*` and the task-fields columns are already there.
3. Adopt the ledger: `DATABASE_URL=... backend/scripts/migrate.sh baseline
   <last applied file>`, then `migrate.sh up` for anything newer.

Rehearse the whole sequence on a copy of the volume first.
