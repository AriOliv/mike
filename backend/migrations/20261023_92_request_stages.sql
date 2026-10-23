-- Migration date: 2026-10-23
--
-- The history of a request's stages (U-13): which stage, with whom, since
-- when. One row per entry into a stage; the open row is the current stage
-- (left_at is null). The stage itself is computed from the status, the card's
-- lane and the checklist (requests.stages.ts); this table remembers the path.
--
-- It does not replace card_events (the card's activity log): it answers "in
-- what stage and since when" without scanning the log, and it is what the
-- time-per-stage report (L-45) and the stage SLA (L-16) will read.
--
-- note is a short label ("movido na Esteira", "checklist fechado"), never text
-- from a contract. Requests that already exist get one row with their current
-- stage, dated from the card's last lane change: the past is not invented.

create table if not exists public.legal_request_stages (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.legal_requests(id) on delete cascade,
  stage text not null,
  owner_kind text not null default 'none',
  owner_id uuid references auth.users(id) on delete set null,
  owner_name text,
  entered_at timestamptz not null default now(),
  left_at timestamptz,
  note text
);

alter table public.legal_request_stages
  drop constraint if exists legal_request_stages_stage_check;
alter table public.legal_request_stages
  add constraint legal_request_stages_stage_check
    check (stage in ('recebido', 'triagem', 'checklist', 'analise', 'negociacao', 'assinatura', 'concluido'));

alter table public.legal_request_stages
  drop constraint if exists legal_request_stages_owner_kind_check;
alter table public.legal_request_stages
  add constraint legal_request_stages_owner_kind_check
    check (owner_kind in ('agent', 'person', 'requester', 'none'));

-- At most one open row per request: the current stage.
create unique index if not exists uq_legal_request_stages_open
  on public.legal_request_stages(request_id)
  where left_at is null;

create index if not exists idx_legal_request_stages_request
  on public.legal_request_stages(request_id, entered_at);

alter table public.legal_request_stages enable row level security;
revoke all on public.legal_request_stages from anon, authenticated;
grant select, insert, update, delete on public.legal_request_stages to service_role;

-- Backfill: one open row for each request that has none, at its present stage.
-- The stage is the pipeline lane's (a closed request is concluded), dated from
-- the card's last lane change or, failing that, from the request itself.
insert into public.legal_request_stages (request_id, stage, owner_kind, entered_at, note)
select r.id,
       case
         when r.status in ('entregue', 'cancelado') or p.lane = 'arquivado' then 'concluido'
         when p.lane = 'assinatura' then 'assinatura'
         when p.lane = 'negociacao' then 'negociacao'
         when p.lane = 'revisao' then 'analise'
         when r.status in ('em_andamento', 'aguardando_solicitante') then 'analise'
         when r.status = 'em_triagem' or p.lane = 'triagem' then 'triagem'
         else 'recebido'
       end,
       'none',
       coalesce(p.lane_updated_at, r.created_at),
       'etapa em que o pedido já estava'
from public.legal_requests r
left join public.projects p on p.id = r.project_id
where not exists (select 1 from public.legal_request_stages s where s.request_id = r.id);
