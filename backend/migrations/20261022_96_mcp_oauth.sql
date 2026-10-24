-- Migration date: 2026-10-22
-- OAuth 2.1 for the MCP server (doc 09 §3.4), so Claude.ai and other MCP
-- clients connect without pasting a token. The Mike is the authorization
-- server; the SDK's handlers speak the protocol (metadata, dynamic client
-- registration, PKCE S256, token, revocation) and these tables hold its
-- state. Issued access and refresh tokens are rows of mcp_access_tokens with
-- kind 'oauth' and the client's id, so scopes, revocation, last use and the
-- audit trail work as for every other token.
--
-- Only hashes of codes and tokens are kept. Backend-owned: browser roles get
-- nothing, RLS on with no policies. Idempotent.

create table if not exists public.mcp_oauth_clients (
  client_id text primary key,
  client_secret_hash text,
  client_name text,
  redirect_uris text[] not null,
  metadata jsonb not null default '{}'::jsonb,
  client_id_issued_at timestamptz not null default now(),
  constraint mcp_oauth_clients_redirects_check check (cardinality(redirect_uris) between 1 and 10)
);

-- An authorization waiting for the person's consent on /oauth/consentir.
create table if not exists public.mcp_oauth_requests (
  id uuid primary key default gen_random_uuid(),
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null,
  state text,
  resource text,
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

-- A single-use authorization code, bound to the person who consented.
create table if not exists public.mcp_oauth_codes (
  code_hash text primary key,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid references public.organizations(id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null,
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.mcp_access_tokens
  add column if not exists client_id text references public.mcp_oauth_clients(client_id) on delete cascade,
  add column if not exists refresh_of uuid references public.mcp_access_tokens(id) on delete cascade,
  add column if not exists resource text;

alter table public.mcp_access_tokens drop constraint if exists mcp_access_tokens_kind_check;
alter table public.mcp_access_tokens
  add constraint mcp_access_tokens_kind_check
  check (kind in ('pessoal', 'servico', 'oauth', 'oauth_refresh'));
alter table public.mcp_access_tokens drop constraint if exists mcp_access_tokens_oauth_client_check;
alter table public.mcp_access_tokens
  add constraint mcp_access_tokens_oauth_client_check
  check ((kind in ('oauth', 'oauth_refresh')) = (client_id is not null));

create index if not exists idx_mcp_access_tokens_client
  on public.mcp_access_tokens(client_id) where client_id is not null;

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_requests enable row level security;
alter table public.mcp_oauth_codes enable row level security;
revoke all on public.mcp_oauth_clients, public.mcp_oauth_requests, public.mcp_oauth_codes from anon, authenticated;
grant select, insert, update, delete
  on public.mcp_oauth_clients, public.mcp_oauth_requests, public.mcp_oauth_codes
  to service_role;
