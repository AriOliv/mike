-- Commercial terms a legal team has to track per contract, not just read once:
-- renewal, the notice window that must be met to stop it, penalties, liability
-- cap and how the counterparty may change the deal.
--
-- notice_deadline is the date the decision must be made by (term_end minus the
-- notice period). Missing it is how a contract renews by accident, so it is
-- stored rather than recomputed ad hoc.
create table if not exists public.contract_terms (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  user_id text not null,

  auto_renewal boolean,
  term_end date,
  notice_days integer,
  notice_deadline date,

  penalty_value text,
  penalty_recurrence text,          -- unica | por_evento
  liability_cap text,

  unilateral_amendment boolean,
  amendment_notes text,
  price_regulatory_impact text,

  -- clause quoted for each field, so every value can be traced to the contract
  sources jsonb not null default '{}'::jsonb,
  extracted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_contract_terms_project
  on public.contract_terms(project_id);

create index if not exists idx_contract_terms_deadline
  on public.contract_terms(user_id, notice_deadline)
  where notice_deadline is not null;

revoke all on public.contract_terms from anon, authenticated;

-- Obligations generated from these terms are marked so a re-run can refresh
-- them without touching deadlines someone entered by hand.
alter table public.obligations
  add column if not exists origin text not null default 'manual';
