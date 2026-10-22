-- Migration date: 2026-10-21
--
-- The legal team's chat agent ("Agente do Legal"): how it behaves in an
-- organization, and the chat channels it is set up for.
--
-- The channel (Slack, WhatsApp, Telegram) only talks; the work and the record
-- stay in Mike, reached through its MCP server. These rows are what the bot
-- reads to know who it is, when it answers, who may ask for what and when a
-- person of the legal team must decide.
--
-- No secret lives here. Bot tokens, signing secrets and verify tokens stay in
-- the deployment's secret store; a channel row keeps only what is safe to
-- show on a settings page (a workspace name, a bot's @username, the last
-- digits of a phone number) and its setup status.

create table if not exists public.legal_agent_settings (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  -- Off until an owner or admin turns it on: a bot reading this row stays silent.
  enabled boolean not null default false,
  display_name text not null default 'Assistente do Legal',
  -- Who it is and how it works, in the team's words; becomes the bot's persona.
  persona text not null default '',
  tone text not null default 'cordial'
    constraint legal_agent_settings_tone_check check (tone in ('formal', 'cordial', 'direto')),
  -- {timezone, days: [1..7], start: "HH:MM", end: "HH:MM", outside: "avisa_e_registra" | "so_registra"}
  hours jsonb not null default '{}'::jsonb,
  -- [{area, kinds: [request kind]}]: who may ask for what. Empty = anyone, anything.
  permissions jsonb not null default '[]'::jsonb,
  -- {risk_levels: [...], kinds: [...], low_confidence: bool, escalate_to_email}
  -- On top of the fixed rule: signing, sending out and accepting risk always go to a person.
  escalation jsonb not null default '{}'::jsonb,
  -- {deadline_days: [30, 7, 1], renewals: bool, radar: bool, digest_time: "HH:MM"}
  proactive jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.legal_agent_channels (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  kind text not null
    constraint legal_agent_channels_kind_check check (kind in ('slack', 'whatsapp', 'telegram')),
  -- rascunho: being set up; configurado: the setup files were generated and
  -- someone marked it installed. Nothing here connects a bot by itself.
  status text not null default 'rascunho'
    constraint legal_agent_channels_status_check check (status in ('rascunho', 'configurado', 'pausado')),
  name text not null,
  -- Non-secret details only (see the note at the top).
  config jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_legal_agent_channels_org
  on public.legal_agent_channels(org_id);

alter table public.legal_agent_settings enable row level security;
alter table public.legal_agent_channels enable row level security;
revoke all on public.legal_agent_settings from anon, authenticated;
revoke all on public.legal_agent_channels from anon, authenticated;
grant select, insert, update, delete on public.legal_agent_settings to service_role;
grant select, insert, update, delete on public.legal_agent_channels to service_role;
