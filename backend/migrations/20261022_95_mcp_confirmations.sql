-- Migration date: 2026-10-22
-- Two-step confirmation of the MCP server's writes (doc 09 §6). The first
-- call of a write tool changes nothing and returns a confirm_token; only the
-- same call with that token runs. A row binds the token to who asked
-- (person + access token + chat identity link), which tool, and the exact
-- arguments (hash of their canonical JSON): a different argument, another
-- tool or another person cannot use it. Single use, ten minutes.
--
-- Only the SHA-256 of the token is kept. Backend-owned: browser roles get
-- nothing, RLS on with no policies. Idempotent.

create table if not exists public.mcp_confirmations (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  access_token_id uuid not null references public.mcp_access_tokens(id) on delete cascade,
  link_id uuid,
  tool text not null,
  args_hash text not null,
  summary text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_mcp_confirmations_expires
  on public.mcp_confirmations(expires_at);

alter table public.mcp_confirmations enable row level security;
revoke all on public.mcp_confirmations from anon, authenticated;
-- delete too: schema.sql's blanket service_role grant gives it, and fresh
-- and upgraded installs must match.
grant select, insert, update, delete on public.mcp_confirmations to service_role;
