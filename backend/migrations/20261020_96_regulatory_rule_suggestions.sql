-- Migration date: 2026-10-20
--
-- "Adicionar ao playbook" from a regulatory change: a SUGGESTED rule an admin
-- approves before it counts. Nothing here writes to a playbook; an approved
-- suggestion is what the playbook owner applies. Fork-only table (slot _96).
-- Backend-owned like the radar's tables: browser roles get nothing.

create table if not exists public.regulatory_rule_suggestions (
  id uuid primary key default gen_random_uuid(),
  change_id uuid not null references public.regulatory_changes(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  -- the playbook the rule is meant for, when one was chosen
  playbook_id uuid references public.playbooks(id) on delete set null,
  title text not null check (length(title) between 1 and 300),
  -- the proposed rule text, in the playbook's own words
  guidance text not null check (length(guidance) between 1 and 4000),
  -- the official passage the rule rests on
  source_quote text,
  source_url text,
  status text not null default 'pendente'
    check (status in ('pendente', 'aprovada', 'rejeitada')),
  suggested_by text not null,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One open suggestion per change: suggesting again edits it instead.
create unique index if not exists uq_regulatory_rule_suggestions_open
  on public.regulatory_rule_suggestions(change_id) where status = 'pendente';
create index if not exists idx_regulatory_rule_suggestions_org
  on public.regulatory_rule_suggestions(org_id, status);

alter table public.regulatory_rule_suggestions enable row level security;
revoke all on public.regulatory_rule_suggestions from anon, authenticated;
grant select, insert, update, delete on public.regulatory_rule_suggestions to service_role;
