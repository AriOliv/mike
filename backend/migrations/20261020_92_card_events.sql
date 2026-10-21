-- Migration date: 2026-10-20
--
-- The contract pipeline's activity log and its agent runs.
--
-- card_events is the CLM's domain log, append-only: who (a person, an agent,
-- the system or the Hermes bot) changed what on a card, before and after, and
-- through which agent run. The activity feed on the home screen and on every
-- card reads it, so people and agents share one timeline.
--
-- agent_runs is one row per agent execution: version, model, cost. It keeps
-- hashes and the validated structured output, never the contract text or the
-- prompt, to keep the personal-data surface small.
--
-- agent_runs comes first so card_events.run_id can reference it. There is no
-- link the other way: a run is tied to the events it caused only through
-- card_events.run_id, which avoids a reference cycle.

create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete cascade,
  -- intake | extrator | verificador | risco | redator | vigia | notificador | qa | revisor
  agent text not null,
  agent_version text not null,
  -- db_jobs.id of the job that ran it, when one did.
  job_id uuid,
  status text not null default 'running'
    constraint agent_runs_status_check
      check (status in ('running', 'succeeded', 'failed', 'skipped', 'needs_human')),
  -- agent:project:document sha, so the same document is not processed twice.
  dedupe_key text,
  model_alias text,
  model_resolved text,
  prompt_sha text,
  input_doc_sha text,
  tokens_in integer,
  tokens_out integer,
  cost_usd numeric(10, 5),
  latency_ms integer,
  output jsonb,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create unique index if not exists uq_agent_runs_dedupe
  on public.agent_runs(dedupe_key)
  where dedupe_key is not null and status = 'succeeded';
create index if not exists idx_agent_runs_project
  on public.agent_runs(project_id, started_at desc);
create index if not exists idx_agent_runs_org_month
  on public.agent_runs(org_id, started_at);

alter table public.agent_runs enable row level security;
revoke all on public.agent_runs from anon, authenticated;
grant select, insert, update on public.agent_runs to service_role;

create table if not exists public.card_events (
  id bigint generated always as identity primary key,
  org_id uuid references public.organizations(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete cascade,
  at timestamptz not null default now(),
  actor_type text not null
    constraint card_events_actor_type_check
      check (actor_type in ('user', 'agent', 'system', 'hermes')),
  -- user id | 'agent:extrator@3' | 'hermes:docbot' | 'cron:vigia'
  actor_id text not null,
  -- How the feed names the actor without a join ("Agente de revisão", a
  -- requester's name). Display only; actor_id is the identity.
  actor_name text,
  -- The e-mail of whoever asked, when a bot acted for them (Hermes, MCP).
  on_behalf_of text,
  -- lane.changed | field.updated | document.added | agent.started |
  -- agent.suggested | agent.failed | review.completed | request.created |
  -- assignee.changed | comment.added | notification.sent ...
  action text not null,
  field text,
  before jsonb,
  after jsonb,
  run_id uuid references public.agent_runs(id) on delete set null,
  source text not null default 'ui'
    constraint card_events_source_check
      check (source in ('ui', 'mcp', 'notion', 'cron', 'agent', 'api'))
);

create index if not exists idx_card_events_project_at
  on public.card_events(project_id, at desc);
create index if not exists idx_card_events_action_at
  on public.card_events(action, at desc);
create index if not exists idx_card_events_at
  on public.card_events(at desc);

-- Append-only. The backend connects as service_role, which RLS does not
-- restrict, so the trigger is the real guard. A retention purge will be a
-- dedicated security-definer function, never an ad hoc delete.
create or replace function public.card_events_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'card_events is append-only';
end
$$;

drop trigger if exists trg_card_events_no_update on public.card_events;
create trigger trg_card_events_no_update
  before update or delete on public.card_events
  for each row execute function public.card_events_append_only();

alter table public.card_events enable row level security;
revoke all on public.card_events from anon, authenticated;
grant select, insert on public.card_events to service_role;
grant usage, select on sequence public.card_events_id_seq to service_role;

-- Agent cost per contract: the badge on a card and the cost panel.
create or replace view public.contract_agent_costs
with (security_invoker = true) as
select org_id, project_id,
       count(*) filter (where status = 'succeeded') as runs_ok,
       count(*) filter (where status = 'failed') as runs_failed,
       coalesce(sum(cost_usd), 0) as cost_usd,
       max(finished_at) as last_run_at
from public.agent_runs
group by org_id, project_id;

revoke all on public.contract_agent_costs from anon, authenticated;
grant select on public.contract_agent_costs to service_role;
