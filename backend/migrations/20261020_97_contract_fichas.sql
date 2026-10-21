-- Migration date: 2026-10-20
-- The Ficha do Contrato (docs/product/contract-schema.v1.json): one versioned
-- JSON per contract project, every field in the schema's envelope, and the
-- risk-rule findings computed from it by code. Fork-only table (slot _97).
-- The backend fronts all access, so browser roles get nothing.

create table if not exists public.contract_fichas (
  project_id uuid primary key references public.projects(id) on delete cascade,
  schema_version text not null default '1.0',
  ficha jsonb not null default '{}'::jsonb,
  document_id uuid references public.documents(id) on delete set null,
  document_version_id uuid references public.document_versions(id) on delete set null,
  model text,
  prompt_version text,
  rules_version text,
  findings jsonb not null default '[]'::jsonb,
  risk_overall text,
  extracted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.contract_fichas drop constraint if exists contract_fichas_risk_overall_check;
alter table public.contract_fichas add constraint contract_fichas_risk_overall_check
  check (risk_overall is null or risk_overall in ('critico', 'atencao', 'ok'));

-- Who confirmed or corrected which field, with the model's reading kept:
-- the audit trail and the quality metric (correction rate per field).
create table if not exists public.contract_field_reviews (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  path text not null,
  action text not null,
  ai_value jsonb,
  final_value jsonb,
  reviewer text not null,
  comment text,
  created_at timestamptz not null default now()
);
alter table public.contract_field_reviews drop constraint if exists contract_field_reviews_action_check;
alter table public.contract_field_reviews add constraint contract_field_reviews_action_check
  check (action in ('confirmado', 'corrigido'));
create index if not exists idx_contract_field_reviews_project
  on public.contract_field_reviews(project_id, created_at desc);

alter table public.contract_fichas enable row level security;
alter table public.contract_field_reviews enable row level security;
revoke all on public.contract_fichas, public.contract_field_reviews from anon, authenticated;
grant select, insert, update, delete on public.contract_fichas, public.contract_field_reviews
  to service_role;
