-- Migration date: 2026-10-22
-- The analyst's analysis of a contract: the reading a legal analyst writes
-- before the team decides (executive summary, critical risks, points of
-- attention, favourable points, redline suggestions, compliance, open
-- points). One row per analysis of a document version, so a new version gets
-- a new analysis and the old one stays as it was. The result is a draft for
-- the legal team, never shown to the requester. Fork-only table (slot _92).

create table if not exists public.contract_analyses (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- The request whose intake answers framed the analysis, if any.
  request_id uuid references public.legal_requests(id) on delete set null,
  document_id uuid references public.documents(id) on delete set null,
  version_id uuid references public.document_versions(id) on delete set null,
  -- The playbook used as the yardstick (the organization's for the contract's
  -- type), and its run, whose findings set the traffic light.
  playbook_id uuid references public.playbooks(id) on delete set null,
  playbook_run_id uuid references public.playbook_runs(id) on delete set null,
  -- The intake answers the analysis considered: [{key, label, value, source}].
  intake jsonb not null default '[]'::jsonb,
  model text,
  status text not null default 'queued',
  result jsonb,
  -- Quotes the verifier could not find in the document, with the reason.
  dropped_citations jsonb not null default '[]'::jsonb,
  -- {model, calls, input_tokens, output_tokens, estimated_cost_usd}.
  usage jsonb,
  error text,
  requested_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.contract_analyses drop constraint if exists contract_analyses_status_check;
alter table public.contract_analyses add constraint contract_analyses_status_check
  check (status in ('queued', 'running', 'done', 'failed'));
create index if not exists idx_contract_analyses_project
  on public.contract_analyses(project_id, created_at desc);
-- One live analysis per document version: asking again returns it.
create unique index if not exists uq_contract_analyses_version
  on public.contract_analyses(version_id) where version_id is not null;

-- One decision per redline suggestion: accepted (applied as a tracked change),
-- edited (applied with the person's wording) or rejected.
create table if not exists public.contract_analysis_decisions (
  analysis_id uuid not null references public.contract_analyses(id) on delete cascade,
  redline_id text not null,
  decision text not null,
  edited_text text,
  edit jsonb,
  reason text,
  decided_by text not null,
  decided_at timestamptz not null default now(),
  primary key (analysis_id, redline_id)
);
alter table public.contract_analysis_decisions drop constraint if exists contract_analysis_decisions_decision_check;
alter table public.contract_analysis_decisions add constraint contract_analysis_decisions_decision_check
  check (decision in ('aceito', 'editado', 'rejeitado'));

alter table public.contract_analyses enable row level security;
alter table public.contract_analysis_decisions enable row level security;
revoke all on public.contract_analyses, public.contract_analysis_decisions from anon, authenticated;
grant select, insert, update, delete on public.contract_analyses, public.contract_analysis_decisions
  to service_role;
