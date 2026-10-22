-- Migration date: 2026-10-21
-- Access tokens for agents calling the Mike MCP server (/mcp), doc 09 §3.
--
-- A token always acts for a person. kind 'pessoal' acts as its owner
-- (user_id). kind 'servico' (a bot such as Hermes, doc 09 §3.2) belongs to
-- one org, is created by an owner/admin (user_id), and acts as the org member
-- whose CONFIRMED chat identity link the call names, and only when can_act_as
-- was granted explicitly. A personal token can never act as anyone else.
-- org_id is the workspace the token reads: the same filter the home screen
-- applies, null for the personal workspace.
--
-- Only the SHA-256 of the token is stored; the plain token is shown once at
-- creation. Revoking stamps revoked_at and never deletes, so the audit trail
-- keeps pointing at a row. Backend-owned like the other contract tables:
-- browser roles get nothing, RLS is on with no policies. Idempotent.

create table if not exists public.mcp_access_tokens (
  id uuid primary key default gen_random_uuid(),
  org_id uuid references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'pessoal',
  name text not null,
  token_hash text not null unique,
  token_prefix text not null,
  scopes text[] not null default '{}',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_used_at timestamptz,
  last_client text,
  can_act_as boolean not null default false,
  created_at timestamptz not null default now(),
  constraint mcp_access_tokens_kind_check check (kind in ('pessoal', 'servico')),
  constraint mcp_access_tokens_act_as_check
    check (not can_act_as or (kind = 'servico' and org_id is not null)),
  constraint mcp_access_tokens_servico_org_check
    check (kind <> 'servico' or org_id is not null),
  constraint mcp_access_tokens_name_check check (char_length(name) between 1 and 80)
);

create index if not exists idx_mcp_access_tokens_user
  on public.mcp_access_tokens(user_id, created_at desc);

alter table public.mcp_access_tokens enable row level security;
revoke all on public.mcp_access_tokens from anon, authenticated;
grant select, insert, update on public.mcp_access_tokens to service_role;
