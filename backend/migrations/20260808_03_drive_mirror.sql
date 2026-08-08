-- Google Drive mirror: where a document also lives in Drive, so the legal team
-- can open contracts from the shared drive they already work in. Null means the
-- document was never mirrored (integration off, or the push failed).
alter table public.documents
  add column if not exists drive_file_id text,
  add column if not exists drive_link text;

create index if not exists idx_documents_drive_pending
  on public.documents(user_id)
  where drive_file_id is null;
