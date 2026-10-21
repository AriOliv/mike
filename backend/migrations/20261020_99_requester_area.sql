-- Migration date: 2026-10-20
--
-- The requesting area of a request to the legal team ("Comercial",
-- "Produto"...), so the team's dashboard counts requests by area rather than
-- by person.
--
-- legal_requests.requester_area is the source; projects.requester_area
-- mirrors it on the card, where the pipeline and the dashboard already read
-- (a card that did not come from a request may carry one too).
-- requester_area_source says where it came from: what the person chose on the
-- form, what the chat bot sent, what was remembered from their last request,
-- or what the triage agent read in the text (the weakest).
--
-- legal_requester_areas remembers a person's area, so the form asks "De qual
-- área você é?" once and fills it in afterwards.

alter table public.legal_requests
  add column if not exists requester_area text,
  add column if not exists requester_area_source text;

alter table public.legal_requests
  drop constraint if exists legal_requests_requester_area_source_check;
alter table public.legal_requests
  add constraint legal_requests_requester_area_source_check
    check (requester_area_source is null
           or requester_area_source in ('form', 'slack', 'perfil', 'triagem'));

create index if not exists idx_legal_requests_org_area
  on public.legal_requests(org_id, requester_area)
  where requester_area is not null;

alter table public.projects
  add column if not exists requester_area text;

create table if not exists public.legal_requester_areas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  area text not null,
  updated_at timestamptz not null default now()
);

alter table public.legal_requester_areas enable row level security;
revoke all on public.legal_requester_areas from anon, authenticated;
grant select, insert, update, delete on public.legal_requester_areas to service_role;

-- Backfill: requests created before this migration take the area the triage
-- agent read, mapped onto the fixed list; the card mirrors it. Only empty
-- rows are touched, so re-running changes nothing.
update public.legal_requests r
   set requester_area = case lower(trim(r.triage->>'area'))
         when 'comercial' then 'Comercial' when 'vendas' then 'Comercial'
         when 'produto' then 'Produto'
         when 'tecnologia' then 'Tecnologia' when 'ti' then 'Tecnologia' when 'engenharia' then 'Tecnologia'
         when 'operações' then 'Operações' when 'operacoes' then 'Operações'
         when 'financeiro' then 'Financeiro' when 'finanças' then 'Financeiro'
         when 'compras' then 'Compras'
         when 'pessoas' then 'Pessoas' when 'rh' then 'Pessoas' when 'recursos humanos' then 'Pessoas'
         when 'marketing' then 'Marketing'
         when 'compliance' then 'Compliance'
         when 'diretoria' then 'Diretoria'
         else null
       end,
       requester_area_source = 'triagem'
 where r.requester_area is null
   and coalesce(trim(r.triage->>'area'), '') <> '';

-- A row whose triage area matched nothing keeps no source.
update public.legal_requests
   set requester_area_source = null
 where requester_area is null and requester_area_source is not null;

update public.projects p
   set requester_area = r.requester_area
  from public.legal_requests r
 where r.project_id = p.id
   and r.requester_area is not null
   and p.requester_area is null;
