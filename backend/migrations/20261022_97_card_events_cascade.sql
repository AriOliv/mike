-- Migration date: 2026-10-22
-- card_events stays append-only while its card lives, but no longer blocks
-- deleting the card. The FK card_events.project_id is ON DELETE CASCADE, and
-- the BEFORE UPDATE OR DELETE trigger raised on the cascade too, so deleting
-- any card with an event failed with 'card_events is append-only'.
--
-- The guard now lets a DELETE through only when the card is already gone,
-- which is the cascade: Postgres removes the parent row before the cascade
-- deletes its events. An UPDATE, or a DELETE of the events of a card that
-- still exists, is refused as before. The card's deletion itself is recorded
-- in the platform's audit_events. Fork-only (slot _97).

create or replace function public.card_events_append_only() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.projects p where p.id = old.project_id
  ) then
    return old;
  end if;
  raise exception 'card_events is append-only';
end
$$;
