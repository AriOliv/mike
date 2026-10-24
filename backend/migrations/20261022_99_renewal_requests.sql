-- Migration date: 2026-10-22
-- A contract's end opens its own renewal request (L-18).
--
-- legal_teams says whether the team wants it and how many days before the end
-- of the term the request opens. contract_renewal_requests ties one request to
-- one term of one contract: the primary key (project_id, term_end) is what
-- makes the job idempotent, so the same end never opens two requests, and a
-- renewed contract (a new term_end) opens a new one. The request is kept when
-- the card goes (set null), like the request itself. Fork-only (slot _99).

alter table public.legal_teams
  add column if not exists renewal_enabled boolean not null default false,
  add column if not exists renewal_lead_days integer not null default 60;

alter table public.legal_teams
  drop constraint if exists legal_teams_renewal_lead_days_check;
alter table public.legal_teams
  add constraint legal_teams_renewal_lead_days_check check (renewal_lead_days between 1 and 365);

create table if not exists public.contract_renewal_requests (
  project_id uuid not null references public.projects(id) on delete cascade,
  term_end date not null,
  request_id uuid references public.legal_requests(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, term_end)
);

alter table public.contract_renewal_requests enable row level security;
revoke all on public.contract_renewal_requests from anon, authenticated;
grant select, insert, update, delete on public.contract_renewal_requests to service_role;
