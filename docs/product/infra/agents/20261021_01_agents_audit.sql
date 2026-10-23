-- RASCUNHO — fundação dos agentes da esteira + auditoria + notificações + tokens
-- MCP. Não executada. Pressupõe a fila db_jobs portada do upstream
-- (upstream/main: backend/migrations/20260829_01_db_jobs.sql), aplicada antes.
--
-- org_id: text com default 'avenia' até o sync trazer public.organizations;
-- aí vira uuid + FK numa migração própria (backfill trivial: tudo = org Avenia).

-- 1) Log de domínio do CLM, append-only. Quem (usuário/agente/sistema/Hermes)
--    mudou o quê, antes/depois, por qual execução.
create table if not exists public.card_events (
  id bigint generated always as identity primary key,
  org_id text not null default 'avenia',
  project_id uuid not null references public.projects(id) on delete cascade,
  at timestamptz not null default now(),
  actor_type text not null check (actor_type in ('user', 'agent', 'system', 'hermes')),
  actor_id text not null,            -- user_id | 'agent:extrator@3' | 'hermes:docbot' | 'cron:vigia'
  on_behalf_of text,                 -- e-mail de quem pediu (Hermes/MCP)
  action text not null,              -- lane.changed | field.updated | document.version_added |
                                     -- agent.started | agent.suggested | agent.failed |
                                     -- request.created | kb.ask | notification.sent | comment.added
  field text,
  before jsonb,
  after jsonb,
  run_id uuid,                       -- agent_runs.id, quando a mudança veio de um agente
  source text not null default 'ui' check (source in ('ui', 'mcp', 'notion', 'cron', 'agent', 'api'))
);

create index if not exists idx_card_events_project_at on public.card_events(project_id, at desc);
create index if not exists idx_card_events_action_at on public.card_events(action, at desc);

-- Append-only: ninguém além do owner do schema atualiza/apaga. O backend usa
-- service_role, então o trigger é a defesa real (RLS não pega service_role).
create or replace function public.card_events_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'card_events is append-only';
end $$;

drop trigger if exists trg_card_events_no_update on public.card_events;
create trigger trg_card_events_no_update
  before update or delete on public.card_events
  for each row execute function public.card_events_append_only();
-- Expurgo por política de retenção: feito por função security definer dedicada
-- que desabilita o trigger na própria transação (mês 2), nunca ad hoc.

revoke all on public.card_events from anon, authenticated;

-- 2) Uma linha por execução de agente: versão, modelo, custo. Sem texto bruto
--    do contrato nem prompt (só hashes) — superfície LGPD mínima.
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'avenia',
  project_id uuid not null references public.projects(id) on delete cascade,
  agent text not null,               -- intake | extrator | verificador | risco | redator | vigia | notificador | qa
  agent_version text not null,
  trigger_event_id bigint references public.card_events(id),
  job_id uuid,                       -- db_jobs.id
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'skipped', 'needs_human')),
  dedupe_key text,                   -- agent:project:doc_sha
  model_alias text,                  -- mike-extract | mike-reason | mike-embed
  model_resolved text,               -- o que a LiteLLM respondeu de fato
  prompt_sha text,
  input_doc_sha text,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10, 5),
  latency_ms integer,
  output jsonb,                      -- saída estruturada validada (sem texto do contrato)
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index if not exists uq_agent_runs_dedupe
  on public.agent_runs(dedupe_key) where dedupe_key is not null and status = 'succeeded';
create index if not exists idx_agent_runs_project on public.agent_runs(project_id, started_at desc);
create index if not exists idx_agent_runs_month on public.agent_runs(org_id, started_at);

revoke all on public.agent_runs from anon, authenticated;

-- Custo por contrato (card) — base do selo no card e do painel /admin/custos.
create or replace view public.contract_agent_costs as
select org_id, project_id,
       count(*) filter (where status = 'succeeded') as runs_ok,
       count(*) filter (where status = 'failed') as runs_failed,
       coalesce(sum(cost_usd), 0) as cost_usd,
       max(finished_at) as last_run_at
from public.agent_runs
group by org_id, project_id;

-- 3) Outbox de notificações (Slack / e-mail / WhatsApp). O worker envia e marca.
create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'avenia',
  project_id uuid references public.projects(id) on delete cascade,
  event_id bigint references public.card_events(id),
  channel text not null check (channel in ('slack_thread', 'slack_dm', 'slack_channel', 'email', 'whatsapp')),
  target text not null,              -- channel_id:thread_ts | e-mail | número
  template text not null,            -- request.received | intake.missing | analysis.ready | deadline.due ...
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text unique,            -- ex.: deadline:<obligation>:<N dias> (não avisa 2x)
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  provider_ref text,                 -- ts da mensagem no Slack
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_notifications_pending on public.notifications(created_at) where status = 'pending';
revoke all on public.notifications from anon, authenticated;

-- 4) Origem do pedido (thread do Slack etc.) — para responder no lugar certo.
alter table public.projects
  add column if not exists org_id text not null default 'avenia',
  add column if not exists requester_email text,
  add column if not exists intake_source jsonb,          -- {channel, channel_id, thread_ts, permalink}
  add column if not exists intake_idempotency_key text;

create unique index if not exists uq_projects_intake_key
  on public.projects(intake_idempotency_key) where intake_idempotency_key is not null;

-- 5) Tokens de serviço do MCP server (um por bot), só o hash fica no banco.
create table if not exists public.mcp_service_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'avenia',
  bot text not null,                 -- docbot | adabuddy | ...
  token_sha256 text not null unique,
  scopes text[] not null,            -- intake:write, requests:read:own, deadlines:read, kb:ask
  created_by text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '90 days',
  last_used_at timestamptz,
  revoked_at timestamptz
);

revoke all on public.mcp_service_tokens from anon, authenticated;

-- 6) org_id nas tabelas do CLM que já existem (tenancy mínima, §4.2).
alter table public.contract_terms add column if not exists org_id text not null default 'avenia';
alter table public.obligations   add column if not exists org_id text not null default 'avenia';
alter table public.dossiers      add column if not exists org_id text not null default 'avenia';
