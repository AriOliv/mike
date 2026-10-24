-- Migration date: 2026-10-22
-- A deadline with an owner and its own warning lead time (L-21/L-22).
-- owner_email is who looks after the deadline and gets the warning; null
-- keeps the old meaning (the person who created it). alert_days is how many
-- days before the due date the warning starts: 30 by default, 0 to 365.
-- Fork-only (slot _98).

alter table public.obligations
  add column if not exists owner_email text,
  add column if not exists alert_days integer not null default 30;

alter table public.obligations
  drop constraint if exists obligations_alert_days_check;
alter table public.obligations
  add constraint obligations_alert_days_check check (alert_days between 0 and 365);

create index if not exists idx_obligations_owner_due
  on public.obligations(lower(owner_email), due_date)
  where owner_email is not null and done = false;
