-- Migration date: 2026-10-23
-- A deadline inside a contract says what it is and where it stands (U-20).
-- kind: vigencia (end of the term) | aviso_previo (notice deadline) |
-- renovacao (decide on renewal) | manual (entered by hand). status: aberto |
-- feito | dispensado. `done` stays, and stays true for feito and dispensado,
-- so the radar and the calendar mirror keep working unchanged.
--
-- Generated deadlines are now updated in place when a contract is read again,
-- one per (project, kind), instead of deleted and recreated: a re-extraction
-- must not undo an owner, a done or a dismissal. Fork-only (slot 20261023_90).

alter table public.obligations
  add column if not exists kind text not null default 'manual',
  add column if not exists status text not null default 'aberto';

alter table public.obligations drop constraint if exists obligations_kind_check;
alter table public.obligations
  add constraint obligations_kind_check
  check (kind in ('vigencia', 'aviso_previo', 'renovacao', 'manual'));

alter table public.obligations drop constraint if exists obligations_status_check;
alter table public.obligations
  add constraint obligations_status_check
  check (status in ('aberto', 'feito', 'dispensado'));

-- Rows already marked done are done; the renewal ones created by the terms
-- extraction get their kind from their title.
update public.obligations set status = 'feito' where done and status = 'aberto';
update public.obligations set kind = 'aviso_previo'
  where origin = 'renewal' and kind = 'manual' and mark = 'critico';
update public.obligations set kind = 'renovacao'
  where origin = 'renewal' and kind = 'manual' and mark = 'tarefa';

-- An old concurrent extraction could leave two generated rows of one kind;
-- keep the newest of each (only generated rows, never a hand-made one) so the
-- unique index below can be built.
delete from public.obligations o
  using public.obligations newer
  where o.origin = 'renewal' and newer.origin = 'renewal'
    and o.project_id = newer.project_id and o.kind = newer.kind
    and (o.created_at, o.id) < (newer.created_at, newer.id);

-- One generated deadline per kind per contract; hand-made ones are free.
create unique index if not exists uq_obligations_generated_kind
  on public.obligations(project_id, kind)
  where origin = 'renewal' and project_id is not null;
