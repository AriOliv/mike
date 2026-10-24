-- Migration date: 2026-10-23
-- Feedback in-app (doc 13): the verdict of the backend's check of the base's names.
-- After redaction, the backend compares the report with the names of the org's
-- contracts, counterparties and files. The names never leave the cluster; only
-- this verdict does, as a label on the issue: `names-clear` (the one door to the
-- auto-fix) or `sensitive`. A report with no verdict (older, or the check could
-- not run) is treated as sensitive. Idempotent.

alter table public.feedback_reports
  add column if not exists names_verdict text
    check (names_verdict is null or names_verdict in ('names-clear', 'sensitive'));
