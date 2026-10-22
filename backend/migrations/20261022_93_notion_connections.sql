-- Migration date: 2026-10-22
--
-- Notion, per organization: the legal team's own board, two ways.
--
-- An organization connects its Notion workspace with an internal integration
-- token (OAuth in phase 2), picks the database it already uses and maps its
-- properties to Mike's card fields, and its stages to Mike's lanes. Replaces
-- the env-wide one-way mirror (lib/notion.ts) for organizations that connect.
--
-- The token is encrypted at rest with AES-256-GCM (key derived from
-- USER_API_KEYS_ENCRYPTION_SECRET, as the organization's provider keys are).
-- It is never sent back to the browser and never logged: the API reports only
-- whether one is set and its last four characters.

create table if not exists public.notion_connections (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  -- Encrypted integration token (all three or none).
  token_encrypted text,
  token_iv text,
  token_tag text,
  token_last4 text,
  -- The database and data source the legal team uses, and their names as last read.
  database_id text,
  data_source_id text,
  database_title text,
  -- {notion property name: mike field} — e.g. {"Contrato": "name", "Etapa": "lane", "Responsável": "assignee"}.
  field_map jsonb not null default '{}'::jsonb,
  -- {notion stage option: {lane, tag}} — tag keeps a stage Mike has no lane for ("Processos").
  stage_map jsonb not null default '{}'::jsonb,
  -- Polling and the incremental cursor (last_edited_time already read).
  sync_enabled boolean not null default false,
  poll_minutes integer not null default 10
    constraint notion_connections_poll_check check (poll_minutes between 5 and 1440),
  pull_cursor timestamptz,
  last_sync_at timestamptz,
  last_sync_error text,
  connected_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notion_connections_token_check check (
    (token_encrypted is null and token_iv is null and token_tag is null)
    or (token_encrypted is not null and token_iv is not null and token_tag is not null)
  )
);

-- The stage the card has on the organization's board when Mike has no lane
-- for it ("Legal Estratégico", "Processos"): shown as a tag, written back.
alter table public.projects
  add column if not exists notion_stage text;

-- One card per Notion page in an organization (projects.notion_page_id exists
-- since 20260808_05; the env-wide mirror never set it per organization).
create unique index if not exists idx_projects_org_notion_page
  on public.projects(org_id, notion_page_id)
  where notion_page_id is not null and org_id is not null;

alter table public.notion_connections enable row level security;
revoke all on public.notion_connections from anon, authenticated;
grant select, insert, update, delete on public.notion_connections to service_role;
