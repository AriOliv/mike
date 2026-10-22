-- Migration date: 2026-10-22
--
-- Who is talking on a chat channel, for the legal team's agent (doc 10 §6.2).
--
-- The chat bot (Hermes) calls Mike with a service token of one organization
-- and names the person only by their chat identity: <platform>:<team>:<user>.
-- Mike acts as someone only through a link that person confirmed once, while
-- logged in to Mike; the e-mail a chat platform reports is never the proof.
--
--   chat_identity_links    a confirmed link: (org, platform, team, user) → user_id,
--                          180 days, revocable
--   chat_link_challenges   the one-time link the bot hands out when there is no
--                          link yet: only the SHA-256 of its token is stored, it
--                          is bound to (org, platform, team, user), lasts 15 min
--                          and works once. The link is made for whoever confirms
--                          it (their session), so opening someone else's link
--                          only links yourself.
--
-- A link is only honoured for a workspace the organization registered on one
-- of its agent channels (legal_agent_channels.platform_team_id), so a link
-- made in another company's Slack cannot be used here.

alter table public.legal_agent_channels
  add column if not exists platform_team_id text;

create unique index if not exists idx_legal_agent_channels_team
  on public.legal_agent_channels(org_id, kind, platform_team_id)
  where platform_team_id is not null;

create table if not exists public.chat_identity_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  platform text not null
    constraint chat_identity_links_platform_check check (platform in ('slack', 'whatsapp', 'telegram')),
  platform_team_id text not null,
  platform_user_id text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  confirmed_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '180 days'),
  revoked_at timestamptz,
  -- The service token whose call led to this link, for the admin's list.
  created_via_token_id uuid,
  created_at timestamptz not null default now()
);

-- One live link per chat identity in an organization.
create unique index if not exists idx_chat_identity_links_active
  on public.chat_identity_links(org_id, platform, platform_team_id, platform_user_id)
  where revoked_at is null;

create index if not exists idx_chat_identity_links_user
  on public.chat_identity_links(user_id, created_at desc);

create table if not exists public.chat_link_challenges (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  org_id uuid not null references public.organizations(id) on delete cascade,
  platform text not null
    constraint chat_link_challenges_platform_check check (platform in ('slack', 'whatsapp', 'telegram')),
  platform_team_id text not null,
  platform_user_id text not null,
  created_via_token_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_chat_link_challenges_expiry
  on public.chat_link_challenges(expires_at) where used_at is null;

alter table public.chat_identity_links enable row level security;
alter table public.chat_link_challenges enable row level security;
revoke all on public.chat_identity_links from anon, authenticated;
revoke all on public.chat_link_challenges from anon, authenticated;
grant select, insert, update, delete on public.chat_identity_links to service_role;
grant select, insert, update, delete on public.chat_link_challenges to service_role;
