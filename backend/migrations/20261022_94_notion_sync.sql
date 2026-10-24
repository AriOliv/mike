-- Migration date: 2026-10-22
--
-- Two-way sync between an organization's cards and its Notion board.
--
-- Mike → Notion: any change on a linked card (a card_events row from
-- anywhere but the sync itself) queues the card once in notion_sync_outbox;
-- a job writes it to its page. One pending row per card: a burst of edits
-- is one push, and a retried event never pushes twice.
--
-- Notion → Mike: a sweep pulls pages edited since the connection's cursor.
-- Per card, notion_seen_at keeps the last_edited_time already applied, so
-- the page edit our own push caused is not read back as someone's change.

create table if not exists public.notion_sync_outbox (
  project_id uuid primary key references public.projects(id) on delete cascade,
  org_id uuid not null references public.organizations(id) on delete cascade,
  status text not null default 'pending'
    constraint notion_sync_outbox_status_check check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  queued_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_notion_sync_outbox_pending
  on public.notion_sync_outbox(org_id, queued_at)
  where status = 'pending';

-- Each mapped property's Notion type ({"Progresso": "status"}), so a write uses
-- the right shape (select and status look alike but are written differently).
alter table public.notion_connections
  add column if not exists field_types jsonb not null default '{}'::jsonb;

-- The Notion last_edited_time already reconciled for the card (pull and push).
alter table public.projects
  add column if not exists notion_seen_at timestamptz;

-- Queue a linked card when anything but the sync changes it.
create or replace function public.notion_sync_enqueue()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.source = 'notion' then
    return new;
  end if;
  insert into public.notion_sync_outbox (project_id, org_id)
  select p.id, p.org_id
  from public.projects p
  join public.notion_connections c on c.org_id = p.org_id and c.sync_enabled
  where p.id = new.project_id and p.notion_page_id is not null
  on conflict (project_id) do update
    set status = 'pending', attempts = 0, last_error = null, queued_at = now();
  return new;
end;
$$;

drop trigger if exists card_events_notion_sync on public.card_events;
create trigger card_events_notion_sync
  after insert on public.card_events
  for each row execute procedure public.notion_sync_enqueue();

revoke all on function public.notion_sync_enqueue() from public, anon, authenticated;

alter table public.notion_sync_outbox enable row level security;
revoke all on public.notion_sync_outbox from anon, authenticated;
grant select, insert, update, delete on public.notion_sync_outbox to service_role;
