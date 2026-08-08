-- Small server-owned key/value store for integration state that is neither
-- user data nor configuration (e.g. the Notion database the pipeline mirror
-- created, and the cursor of the last sync).
create table if not exists public.app_settings (
  key text primary key,
  value text not null default '',
  updated_at timestamptz not null default now()
);

revoke all on public.app_settings from anon, authenticated;
