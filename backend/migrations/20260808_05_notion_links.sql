-- Where a pipeline project lives on the Notion board, so the app can link
-- straight to the card instead of dropping people at the top of the database.
-- Filled in by the mirror; null until a project has been synced.
alter table public.projects
  add column if not exists notion_page_id text,
  add column if not exists notion_url text;
