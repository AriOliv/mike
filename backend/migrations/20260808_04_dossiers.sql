-- AI contract analysis ("dossier"): the structured review of a contract —
-- critical risks, points of attention, suggested redlines, compliance notes —
-- where every item quotes the clause it came from, so a reviewer can always
-- trace a finding back to the document text.
create table if not exists public.dossiers (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null unique references public.projects(id) on delete cascade,
  user_id text not null,
  payload jsonb not null default '{}'::jsonb,
  risk_level text,
  source text not null default 'import',   -- import | generated
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_dossiers_project
  on public.dossiers(project_id);

revoke all on public.dossiers from anon, authenticated;
