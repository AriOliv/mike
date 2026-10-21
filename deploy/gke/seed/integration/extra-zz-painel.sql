-- requires-table: public.agent_runs public.regulatory_changes public.projects.requester_area public.legal_requests.requester_area
-- Seed sintético para o Painel do Legal (PR #10) bater com o resto da prévia.
-- Roda por último (extra-zz-*), depois do Início e da Revisão. 100% fictício,
-- idempotente (ids fixos, on conflict do nothing).
--   1. Todo contrato com termos extraídos ou afetado pelo radar tem uma revisão
--      concluída por agente no período (agent_runs do "revisor" succeeded).
--   2. Área de quem pediu nos cards e pedidos (20261020_99 do Relay), com um
--      card sem área de propósito (o Painel mostra "Sem área").
--   3. As duas varreduras do seed ficam com mudanças em aberto (já vêm de
--      extra-integration.sql; aqui só garante que nenhuma foi arquivada).

begin;

-- 1. Revisões por agente nos contratos com termos e nos afetados pelo radar.
insert into public.agent_runs
  (id, org_id, project_id, agent, agent_version, status, dedupe_key, model_alias, model_resolved,
   tokens_in, tokens_out, cost_usd, latency_ms, output, started_at, finished_at)
select ('00000000-0000-4000-f200-0000000000' || right(p.id::text, 2))::uuid,
       '00000000-0000-4000-c000-000000000001', p.id, 'revisor', '1', 'succeeded',
       'seed:revisor:' || right(p.id::text, 2), 'mike-reason', 'seed-model',
       9000, 1100, 0.03800, 14000, '{"aligned":8,"needs_review":2,"deviates":1}'::jsonb,
       now() - make_interval(days => p.n) - interval '15 minutes', now() - make_interval(days => p.n)
from (
  select pid as id, row_number() over (order by pid) as n
  from (
    select project_id as pid from public.contract_terms
    where project_id::text like '00000000-0000-4000-a000-%'
    union  -- union already removes duplicates
    select (a->>'project_id')::uuid
    from public.regulatory_changes c, jsonb_array_elements(c.affected) a
    where c.scan_id::text like '00000000-0000-4000-e000-%'
  ) s
) p
on conflict (id) do nothing;

-- 2. Área de quem pediu (as do Relay: REQUESTER_AREAS em requests.shared.ts).
update public.projects p
set requester_area = v.area
from (values
  ('00000000-0000-4000-a000-000000000001'::uuid, 'Comercial'),
  ('00000000-0000-4000-a000-000000000002'::uuid, 'Compras'),
  ('00000000-0000-4000-a000-000000000003'::uuid, 'Financeiro'),
  ('00000000-0000-4000-a000-000000000004'::uuid, 'Comercial'),
  ('00000000-0000-4000-a000-000000000005'::uuid, 'Operações'),
  ('00000000-0000-4000-a000-000000000006'::uuid, 'Compras'),
  ('00000000-0000-4000-a000-000000000007'::uuid, 'Produto'),
  -- 08 (Distrato Gama Eventos) fica sem área de propósito
  ('00000000-0000-4000-a000-000000000009'::uuid, 'Tecnologia'),
  ('00000000-0000-4000-a000-000000000010'::uuid, 'Financeiro'),
  ('00000000-0000-4000-a000-000000000011'::uuid, 'Operações'),
  ('00000000-0000-4000-a000-000000000012'::uuid, 'Comercial')
) as v(id, area)
where p.id = v.id and p.requester_area is null;

update public.legal_requests r
set requester_area = v.area, requester_area_source = 'form'
from (values
  ('00000000-0000-4000-d000-000000000001'::uuid, 'Comercial'),
  ('00000000-0000-4000-d000-000000000002'::uuid, 'Compras'),
  ('00000000-0000-4000-d000-000000000003'::uuid, 'Produto'),
  ('00000000-0000-4000-d000-000000000004'::uuid, 'Operações'),
  ('00000000-0000-4000-d000-000000000005'::uuid, 'Comercial')
  -- 06 (cancelado) fica sem área
) as v(id, area)
where r.id = v.id and r.requester_area is null;

-- 3. Mudanças em aberto nas duas varreduras.
update public.regulatory_changes
set status = 'nova'
where scan_id in ('00000000-0000-4000-e000-000000000001', '00000000-0000-4000-e000-000000000002')
  and status = 'arquivada';

commit;
