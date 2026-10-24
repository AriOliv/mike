-- Migration date: 2026-10-23
--
-- An amendment or renewal request points at the contract it changes (U-05).
-- parent_project_id is that contract's card: what ties the amendment to the
-- term and the renewal the obligations track. It is kept when the card goes
-- (set null), like the request itself.

alter table public.legal_requests
  add column if not exists parent_project_id uuid references public.projects(id) on delete set null;

create index if not exists legal_requests_parent_project_idx
  on public.legal_requests (parent_project_id)
  where parent_project_id is not null;
