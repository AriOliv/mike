-- Migration date: 2026-10-23
-- In-app feedback (doc 13): a person (or an agent over MCP) reports a bug or
-- suggests a feature. The row is the durable record; a db_jobs job turns it
-- into an issue in the PRIVATE feedback repo, so the report is never lost
-- when GitHub is down. The text arrives already redacted (e-mail, CPF, CNPJ,
-- phone); the original is not kept. The user id is stored, never the e-mail.
-- Backend-owned: browser roles get nothing, RLS on with no policies. Idempotent.

create sequence if not exists public.feedback_report_seq;

create table if not exists public.feedback_reports (
  id uuid primary key default gen_random_uuid(),
  -- The number the person is given ("REL-0042"): ours, it exists before any issue does.
  number integer not null unique default nextval('public.feedback_report_seq'),
  user_id uuid references auth.users(id) on delete set null,
  org_id uuid references public.organizations(id) on delete set null,
  source text not null check (source in ('app', 'agent')),
  -- The MCP client's name when an agent reported; null from the app.
  client text,
  kind text not null check (kind in ('bug', 'feature')),
  body text not null,
  expected text,
  route text,
  app_version text,
  browser text,
  role text,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  issue_number integer,
  attempts integer not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_feedback_reports_user_created
  on public.feedback_reports(user_id, created_at desc);
create index if not exists idx_feedback_reports_status
  on public.feedback_reports(status) where status <> 'sent';

alter table public.feedback_reports enable row level security;
revoke all on public.feedback_reports from anon, authenticated;
grant select, insert, update, delete on public.feedback_reports to service_role;
grant usage, select on sequence public.feedback_report_seq to service_role;
