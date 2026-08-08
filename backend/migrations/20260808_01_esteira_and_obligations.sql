-- Contract pipeline ("esteira") + deadline radar.
--
-- A project with a non-null `lane` is a contract moving through the pipeline,
-- so pipeline cards reuse everything a project already has: documents, chat,
-- tabular reviews and sharing. Projects without a lane are unaffected.

alter table public.projects
  add column if not exists counterparty text,
  add column if not exists lane text,
  add column if not exists risk_level text,
  add column if not exists requester_name text,
  add column if not exists lane_updated_at timestamptz;

-- Only pipeline projects are indexed; the partial index keeps the board query
-- cheap without touching ordinary projects.
create index if not exists idx_projects_lane
  on public.projects(user_id, lane)
  where lane is not null;

-- Deadlines/obligations plotted on the radar. matter_id is the pipeline
-- project the deadline came from (nullable: standing obligations have none).
create table if not exists public.obligations (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  project_id uuid references public.projects(id) on delete cascade,
  title text not null,
  mark text not null default 'recorrente',   -- recorrente | critico | tarefa
  due_date date not null,
  done boolean not null default false,
  note text,
  source_quote text,                          -- verbatim clause the date came from
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_obligations_user_due
  on public.obligations(user_id, due_date);

create index if not exists idx_obligations_project
  on public.obligations(project_id);

-- Backend-owned data: reachable only through the service role, like projects.
revoke all on public.obligations from anon, authenticated;
