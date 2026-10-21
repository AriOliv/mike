-- Migration date: 2026-10-20
--
-- Requests to the legal team ("pedidos"). Anyone in the company asks for a
-- contract review, a draft or an opinion; the request gets a readable number
-- (LEG-0001), an SLA, an AI summary, and a card on the pipeline's first lane.
--
-- The card is an ordinary pipeline project in the legal team's organization,
-- so the team works it with everything a project already has. The requester
-- is NOT given access to that project: they see the request through its own
-- narrow surface (status, questions, delivery), never the team's portfolio.
-- People outside the team who must follow one request -- an outside law firm,
-- a colleague from the business -- are request participants, scoped to that
-- request and expiring.

-- Which organization is the legal team. One per deployment in practice; a
-- table rather than a setting so it is an ordinary foreign key and the team's
-- members are just that organization's members.
create table if not exists public.legal_teams (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  -- SLA in business days, by request kind. Defaults apply to missing kinds.
  sla_days jsonb not null default '{}'::jsonb,
  -- When true, the triage agent's suggested assignee is applied at once
  -- instead of waiting for the Head to accept it.
  auto_assign boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.legal_teams enable row level security;
revoke all on public.legal_teams from anon, authenticated;
grant select, insert, update, delete on public.legal_teams to service_role;

create sequence if not exists public.legal_request_number_seq;
revoke all on sequence public.legal_request_number_seq from anon, authenticated;
grant usage, select on sequence public.legal_request_number_seq to service_role;

create table if not exists public.legal_requests (
  id uuid primary key default gen_random_uuid(),
  number bigint not null unique default nextval('public.legal_request_number_seq'),
  org_id uuid not null references public.organizations(id) on delete restrict,
  -- The card. Kept when the card is deleted so the requester's history and
  -- the number survive; the request then shows as closed.
  project_id uuid unique references public.projects(id) on delete set null,
  requester_id uuid references auth.users(id) on delete set null,
  requester_email text not null,
  requester_name text,
  kind text not null
    constraint legal_requests_kind_check
      check (kind in ('contrato_novo', 'revisao', 'aditivo', 'nda', 'parecer', 'outro')),
  title text not null,
  counterparty text,
  context text not null default '',
  urgency text not null default 'normal'
    constraint legal_requests_urgency_check check (urgency in ('normal', 'alta', 'urgente')),
  needed_by date,
  due_at timestamptz not null,
  -- novo | em_triagem | em_andamento | aguardando_solicitante | entregue | cancelado
  status text not null default 'novo'
    constraint legal_requests_status_check
      check (status in ('novo', 'em_triagem', 'em_andamento', 'aguardando_solicitante', 'entregue', 'cancelado')),
  -- Time the SLA spent paused while waiting on the requester.
  paused_at timestamptz,
  paused_seconds integer not null default 0,
  assignee_id uuid references auth.users(id) on delete set null,
  assigned_at timestamptz,
  summary text,
  -- The triage agent's latest suggestion and the team's verdict on it:
  -- {kind, counterparty, area, assignee_id, playbook_id, reasons[], missing[],
  --  decision: null | 'accepted' | 'edited' | 'rejected', decided_by, decided_at}
  triage jsonb,
  -- What the team sent back: {message, document_ids[], delivered_by}
  delivery jsonb,
  delivered_at timestamptz,
  -- Where the request came from, to answer in the same place later.
  source jsonb not null default '{"channel": "form"}'::jsonb,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint legal_requests_email_lowercase check (requester_email = lower(requester_email))
);

create index if not exists idx_legal_requests_requester
  on public.legal_requests(requester_email, created_at desc);
create index if not exists idx_legal_requests_org_status
  on public.legal_requests(org_id, status, due_at);
create index if not exists idx_legal_requests_assignee
  on public.legal_requests(assignee_id, status)
  where assignee_id is not null;

alter table public.legal_requests enable row level security;
revoke all on public.legal_requests from anon, authenticated;
grant select, insert, update, delete on public.legal_requests to service_role;

-- People outside the team who follow one request. Addressed by normalized
-- email so an outside firm can be invited before it has an account.
create table if not exists public.legal_request_participants (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.legal_requests(id) on delete cascade,
  email text not null,
  -- 'external': an outside firm (can answer and attach); 'viewer': follows only.
  role text not null default 'external'
    constraint legal_request_participants_role_check check (role in ('external', 'viewer')),
  label text,
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '90 days',
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  unique (request_id, email),
  constraint legal_request_participants_email_lowercase check (email = lower(email))
);

create index if not exists idx_legal_request_participants_email
  on public.legal_request_participants(email)
  where revoked_at is null;

alter table public.legal_request_participants enable row level security;
revoke all on public.legal_request_participants from anon, authenticated;
grant select, insert, update, delete on public.legal_request_participants to service_role;

-- The conversation between the team and the requester (and invited
-- participants). Internal notes stay on the card's activity, not here.
create table if not exists public.legal_request_messages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.legal_requests(id) on delete cascade,
  author_id uuid references auth.users(id) on delete set null,
  author_email text not null,
  author_name text,
  -- 'question': the team asks and waits; 'answer': the requester replies;
  -- 'note': anything else visible to the requester.
  kind text not null default 'note'
    constraint legal_request_messages_kind_check check (kind in ('question', 'answer', 'note')),
  body text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_legal_request_messages_request
  on public.legal_request_messages(request_id, created_at);

alter table public.legal_request_messages enable row level security;
revoke all on public.legal_request_messages from anon, authenticated;
grant select, insert, update, delete on public.legal_request_messages to service_role;

-- Outbox of e-mail notifications. A job sends pending rows; the dedupe key
-- keeps a retried event from mailing twice.
create table if not exists public.legal_request_notifications (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.legal_requests(id) on delete cascade,
  template text not null
    constraint legal_request_notifications_template_check
      check (template in ('request.created', 'request.assigned', 'request.question',
                          'request.delivered', 'request.invited')),
  recipient text not null,
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null unique,
  status text not null default 'pending'
    constraint legal_request_notifications_status_check
      check (status in ('pending', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_legal_request_notifications_pending
  on public.legal_request_notifications(created_at)
  where status = 'pending';

alter table public.legal_request_notifications enable row level security;
revoke all on public.legal_request_notifications from anon, authenticated;
grant select, insert, update, delete on public.legal_request_notifications to service_role;
