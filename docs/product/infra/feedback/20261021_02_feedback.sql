-- RASCUNHO — migração do widget de feedback. Não executada.
-- Só habilitado em staging/prévias (FEEDBACK_ENABLED), mas a tabela existe em
-- todo ambiente para o schema não divergir.
create table if not exists public.feedback (
  id uuid primary key default gen_random_uuid(),
  org_id text not null default 'avenia',
  user_id text not null,
  user_email text,
  kind text not null check (kind in ('bug', 'sugestao', 'duvida', 'elogio')),
  message text not null check (length(message) between 3 and 5000),
  route text,                         -- pathname da tela
  project_id uuid references public.projects(id) on delete set null,
  env_label text,                     -- staging | pr-<n>
  build_sha text,
  user_agent text,
  viewport text,
  screenshot_path text,               -- objeto no storage (opcional)
  github_issue_url text,
  github_issue_number integer,
  status text not null default 'novo' check (status in ('novo', 'triado', 'resolvido', 'descartado')),
  created_at timestamptz not null default now()
);

create index if not exists idx_feedback_created on public.feedback(created_at desc);
revoke all on public.feedback from anon, authenticated;
