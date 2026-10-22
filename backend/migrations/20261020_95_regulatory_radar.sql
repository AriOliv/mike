-- Migration date: 2026-10-20
--
-- Regulatory radar ("radar regulatório"): saved scans over Brazilian public
-- sources (BCB normativos, DOU, CVM and Receita news) and the changes each
-- scan found, crossed with the contract base.
--
-- A scan belongs to an organization when org_id is set (every member sees it
-- and its changes) and to its creator otherwise. A change is shared triage
-- state for whoever sees its scan: read, starred and archived are team-wide,
-- because a team of three triages one list together. Contracts a change
-- affects are stored as ids and filtered by the reader's project access at
-- read time, so nobody learns of a contract they cannot open.
--
-- Backend-owned, like the other contract tables: browser roles get nothing,
-- RLS is on with no policies, service_role does the work. Idempotent.

create table if not exists public.regulatory_scans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  org_id uuid references public.organizations(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  -- the preset this scan started from (bcb_pagamentos_cripto, lgpd_anpd ...)
  preset text,
  -- source ids from the backend's registry: bcb_normativos | dou | cvm_noticias | rfb_noticias
  sources text[] not null default '{}',
  -- DOU issuers the scan follows (matched on the act's hierarchy)
  issuers text[] not null default '{}',
  -- an item must mention one of these (accent- and case-insensitive); empty = all
  keywords text[] not null default '{}',
  -- Avenia themes the scan covers: psp | cripto | cambio | lgpd | pld
  topics text[] not null default '{}',
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_regulatory_scans_org on public.regulatory_scans(org_id);
create index if not exists idx_regulatory_scans_user on public.regulatory_scans(user_id);
create index if not exists idx_regulatory_scans_due
  on public.regulatory_scans(last_run_at) where enabled;

create table if not exists public.regulatory_changes (
  id uuid primary key default gen_random_uuid(),
  scan_id uuid not null references public.regulatory_scans(id) on delete cascade,
  source text not null,
  -- the source's own id for the item (BCB listItemId, DOU urlTitle, RSS link)
  external_id text not null,
  title text not null,
  act_type text,
  issuer text,
  published_at date,
  url text,
  -- verbatim official text the change is cited from
  excerpt text,
  -- two-line summary in PT; null when no model ran or its quote did not check out
  summary text,
  summary_quote text,
  impact text not null default 'baixo' check (impact in ('alto', 'medio', 'baixo')),
  impact_reason text,
  effective_date date,
  topics text[] not null default '{}',
  matched_terms text[] not null default '{}',
  -- [{project_id, term, quote}] — which contracts mention what
  affected jsonb not null default '[]'::jsonb,
  suggested_action text,
  status text not null default 'nova' check (status in ('nova', 'lida', 'arquivada')),
  starred boolean not null default false,
  -- what the team did about it
  request_project_id uuid references public.projects(id) on delete set null,
  obligation_id uuid references public.obligations(id) on delete set null,
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (scan_id, source, external_id)
);

create index if not exists idx_regulatory_changes_scan
  on public.regulatory_changes(scan_id, published_at desc);
create index if not exists idx_regulatory_changes_open
  on public.regulatory_changes(scan_id) where status <> 'arquivada';

alter table public.regulatory_scans enable row level security;
alter table public.regulatory_changes enable row level security;
revoke all on public.regulatory_scans from anon, authenticated;
revoke all on public.regulatory_changes from anon, authenticated;
grant select, insert, update, delete
  on public.regulatory_scans, public.regulatory_changes
  to service_role;
