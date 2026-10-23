-- Migration date: 2026-10-23
-- Cache of the CNPJ lookup (L-54). The data is the Receita's public company
-- record (razão social, CNAE, endereço, situação), never a CPF. One row per
-- CNPJ, shared by every team; refreshed after CNPJ_CACHE_DAYS. Backend-owned:
-- browser roles get nothing, RLS on with no policies. Idempotent.

create table if not exists public.cnpj_lookups (
  cnpj text primary key check (cnpj ~ '^[0-9]{14}$'),
  payload jsonb not null,
  fetched_at timestamptz not null default now()
);

alter table public.cnpj_lookups enable row level security;
revoke all on public.cnpj_lookups from anon, authenticated;
grant select, insert, update, delete on public.cnpj_lookups to service_role;
