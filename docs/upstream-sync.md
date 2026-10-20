# Keeping the fork in sync with upstream

This fork (`AriOliv/mike`) carries the Avenia CLM features — pipeline, radar,
dossier, contract terms, acervo, and the Notion/Drive/Calendar mirrors — on
top of `open-legal-products/mike`. All of that code lives in
`backend/src/modules/contracts/`, three mirror files in `backend/src/lib/`
(`notion.ts`, `drive.ts`, `gcal.ts`, plus `google.ts`), the CLM pages under
`frontend/src/app/(pages)/{pipeline,radar,acervo}` and the project
`dossier`/`review` tabs, and migrations named `20260808_*` and
`20261020_02_task_fields.sql`. Keeping it there is what keeps merges small.

## The weekly routine

`.github/workflows/upstream-sync.yml` runs every Monday (and on demand):

- clean merge → pushes `sync/upstream-<date>` and opens a **draft PR** listing
  the new upstream migrations;
- conflicting merge → opens an **issue** listing the conflicted files.

A PR opened with the workflow's `GITHUB_TOKEN` does not trigger other
workflows. Either close and reopen the PR to start CI, or give the workflow a
fine-grained token (`contents`, `pull-requests`, `issues`: write) as the
`SYNC_TOKEN` secret and pass it to `gh` and `actions/checkout`.

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
  slot (see `migrationLedger.test.ts`).
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
