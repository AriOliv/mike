-- Migration date: 2026-10-20
-- A contract review is a playbook run tied to a contract project: the run
-- (upstream playbook_runs) keeps the findings and the tracked-change version;
-- this row records which contract it reviewed and what each person decided
-- on each suggestion. Fork-only tables (slot _98).

create table if not exists public.contract_reviews (
  run_id uuid primary key references public.playbook_runs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  document_id uuid references public.documents(id) on delete set null,
  playbook_id uuid not null references public.playbooks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists idx_contract_reviews_project
  on public.contract_reviews(project_id, created_at desc);

-- One decision per finding: accepted, edited (with the person's wording), or
-- rejected (with an optional one-line reason that feeds playbook tuning).
create table if not exists public.contract_review_decisions (
  run_id uuid not null references public.contract_reviews(run_id) on delete cascade,
  finding_id text not null,
  decision text not null,
  edited_text text,
  -- The tracked change an edit made in place of the suggestion's.
  edit jsonb,
  reason text,
  decided_by text not null,
  decided_at timestamptz not null default now(),
  primary key (run_id, finding_id)
);
alter table public.contract_review_decisions drop constraint if exists contract_review_decisions_decision_check;
alter table public.contract_review_decisions add constraint contract_review_decisions_decision_check
  check (decision in ('aceito', 'editado', 'rejeitado'));

alter table public.contract_reviews enable row level security;
alter table public.contract_review_decisions enable row level security;
revoke all on public.contract_reviews, public.contract_review_decisions from anon, authenticated;
grant select, insert, update, delete on public.contract_reviews, public.contract_review_decisions
  to service_role;
