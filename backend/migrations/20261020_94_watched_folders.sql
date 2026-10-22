-- Migration date: 2026-10-20
--
-- Automatic review of watched folders: the home screen's queue.
--
-- A watched folder is a group of contract cards the legal team wants read as
-- soon as a document lands in them: one batch upload, or a Drive folder whose
-- files are already mirrored. Every new document version in a watched card
-- gets one contract_reviews row; a background job fills in the contract's
-- terms (the Ficha) and runs the folder's playbook, and the row keeps what a
-- person needs to triage it without opening the document: the agent's step,
-- the traffic-light counts, a short summary and who should look at it.

create table if not exists public.watched_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete restrict,
  created_by uuid references auth.users(id) on delete set null,
  name text not null,
  -- upload: a batch sent from the home screen; drive: a mirrored Drive folder.
  source text not null default 'upload'
    constraint watched_folders_source_check check (source in ('upload', 'drive')),
  drive_folder_id text,
  drive_link text,
  -- The playbook new documents are reviewed against; null reads only the Ficha.
  playbook_id uuid references public.playbooks(id) on delete set null,
  -- Who new reviews are assigned to; null leaves them for the head to assign.
  default_assignee_email text,
  active boolean not null default true,
  last_scanned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_watched_folders_org
  on public.watched_folders(org_id) where active;

alter table public.projects
  add column if not exists watched_folder_id uuid
    references public.watched_folders(id) on delete set null;

create index if not exists idx_projects_watched_folder
  on public.projects(watched_folder_id) where watched_folder_id is not null;

create table if not exists public.contract_reviews (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete restrict,
  project_id uuid not null references public.projects(id) on delete cascade,
  document_id uuid not null references public.documents(id) on delete cascade,
  -- The version reviewed; a new version gets a new review.
  version_id uuid not null references public.document_versions(id) on delete cascade,
  watched_folder_id uuid references public.watched_folders(id) on delete set null,
  -- queued → running → ready (a person should look) → done (a person decided).
  status text not null default 'queued'
    constraint contract_reviews_status_check
      check (status in ('queued', 'running', 'ready', 'done', 'failed')),
  -- What the agent is doing right now, shown instead of a bare spinner.
  step text
    constraint contract_reviews_step_check
      check (step is null or step in ('lendo', 'ficha', 'playbook')),
  playbook_id uuid references public.playbooks(id) on delete set null,
  playbook_run_id uuid references public.playbook_runs(id) on delete set null,
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  -- The person whose models and keys the agent runs with.
  requested_by uuid references auth.users(id) on delete set null,
  assignee_email text,
  aligned integer not null default 0,
  needs_review integer not null default 0,
  deviates integer not null default 0,
  summary text,
  error text,
  -- Who accepted the review and when; null until a person decides.
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint contract_reviews_version_unique unique (version_id)
);

create index if not exists idx_contract_reviews_project
  on public.contract_reviews(project_id, created_at desc);
create index if not exists idx_contract_reviews_status
  on public.contract_reviews(status, updated_at desc);
create index if not exists idx_contract_reviews_assignee
  on public.contract_reviews(assignee_email, status)
  where assignee_email is not null;

-- When a person last opened the home screen, for "since your last visit".
create table if not exists public.home_visits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  previous_seen_at timestamptz,
  last_seen_at timestamptz not null default now()
);

alter table public.watched_folders enable row level security;
alter table public.contract_reviews enable row level security;
alter table public.home_visits enable row level security;

revoke all on public.watched_folders from anon, authenticated;
revoke all on public.contract_reviews from anon, authenticated;
revoke all on public.home_visits from anon, authenticated;

grant select, insert, update, delete
  on public.watched_folders, public.contract_reviews, public.home_visits
  to service_role;
