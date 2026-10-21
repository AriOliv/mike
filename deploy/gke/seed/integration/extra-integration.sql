-- Seed sintético extra da prévia de integração (seed/integration, componente usado
-- pelo overlay preview): pedidos ao
-- Legal (20261020_93), radar regulatório (20261020_95) e o log card_events /
-- agent_runs (20261020_92). Roda depois de seed.sql, só onde essas migrações
-- existem. 100% fictício, ids fixos, idempotente (on conflict do nothing).
-- Atos regulatórios inventados: números e URLs não correspondem a normas reais.

begin;

-- Time do Legal: org de equipe com a conta legal como owner e a solicitante
-- como member (a fila inteira é do time; a solicitante vê só os pedidos dela).
with legal as (select id from public._seed_users where role = 'legal')
insert into public.organizations (id, name, created_by, kind)
select '00000000-0000-4000-c000-000000000001'::uuid, 'Avenia Legal (demo)', legal.id, 'team' from legal
on conflict (id) do nothing;

insert into public.org_members (org_id, user_id, role)
select '00000000-0000-4000-c000-000000000001'::uuid, u.id,
       case when u.role = 'legal' then 'owner' else 'member' end
from public._seed_users u
on conflict (org_id, user_id) do nothing;

insert into public.legal_teams (org_id, sla_days, auto_assign)
values ('00000000-0000-4000-c000-000000000001', '{}'::jsonb, false)
on conflict (org_id) do nothing;

-- Pedidos LEG-0001..0006 em todos os estados da fila.
with legal as (select id, email from public._seed_users where role = 'legal'),
     sol   as (select id, email from public._seed_users where role = 'solicitante'),
reqs(id, num, project_id, kind, title, counterparty, context, urgency, due_days, status, assigned, summary, triage) as (values
  ('00000000-0000-4000-d000-000000000001'::uuid, 1, '00000000-0000-4000-a000-000000000001'::uuid, 'nda',
   'NDA para conversa comercial com a Acme', 'Acme Pagamentos (fictícia)',
   'Vamos apresentar a API de pagamentos na semana que vem e a Acme pediu NDA mútuo antes da call.',
   'alta', 2, 'em_triagem', false,
   'Comercial precisa de um NDA mútuo com a Acme antes de uma reunião de apresentação da API na próxima semana.',
   jsonb_build_object('kind','nda','kind_changed',false,'counterparty','Acme Pagamentos (fictícia)','area','Comercial',
     'missing', jsonb_build_array('CNPJ da contraparte','prazo de confidencialidade desejado'),
     'assignee_id', null, 'assignee_name','Legal Demo','assignee_reason','Legal Demo: 2 pedidos abertos.',
     'playbook_id', null, 'playbook_name', null, 'ai', true, 'suggested_at', now() - interval '20 minutes', 'decision', null)),
  ('00000000-0000-4000-d000-000000000002'::uuid, 2, '00000000-0000-4000-a000-000000000002'::uuid, 'revisao',
   'Revisar minuta de prestação de serviços da Delta TI', 'Delta TI Ltda (fictícia)',
   'A Delta mandou a minuta deles. Precisamos assinar até sexta para começar o projeto de migração.',
   'urgente', 1, 'em_andamento', true,
   'Compras precisa revisar a minuta de prestação de serviços enviada pela Delta TI para iniciar a migração até sexta.',
   jsonb_build_object('kind','revisao','kind_changed',false,'counterparty','Delta TI Ltda (fictícia)','area','Compras',
     'missing', '[]'::jsonb, 'assignee_name','Legal Demo','assignee_reason','Legal Demo: 1 pedido aberto.',
     'ai', true, 'suggested_at', now() - interval '2 days', 'decision','accepted', 'decided_at', now() - interval '2 days')),
  ('00000000-0000-4000-d000-000000000003'::uuid, 3, null, 'parecer',
   'Podemos usar dados de clientes em teste A/B?', null,
   'Produto quer rodar um experimento de onboarding usando e-mail e histórico de uso dos clientes.',
   'normal', 6, 'aguardando_solicitante', true,
   'Produto pergunta se pode usar dados pessoais de clientes num experimento de onboarding.',
   jsonb_build_object('kind','parecer','kind_changed',false,'counterparty',null,'area','Produto',
     'missing', jsonb_build_array('quais dados exatamente','base legal pretendida'),
     'ai', true, 'suggested_at', now() - interval '3 days', 'decision','accepted', 'decided_at', now() - interval '3 days')),
  ('00000000-0000-4000-d000-000000000004'::uuid, 4, null, 'aditivo',
   'Aditivo de reajuste — Beta Limpeza', 'Beta Limpeza (fictícia)',
   'Reajuste anual pelo IPCA chegou. A Beta quer 9%, o índice deu menos.',
   'normal', 9, 'novo', false, null, null),
  ('00000000-0000-4000-d000-000000000005'::uuid, 5, null, 'contrato_novo',
   'Contrato de parceria com a Orion', 'Orion Parcerias (fictícia)',
   'Parceria de indicação de clientes com rebate de 10%.',
   'normal', -3, 'entregue', true,
   'Comercial precisa de contrato de parceria de indicação com rebate de 10% com a Orion.',
   jsonb_build_object('kind','contrato_novo','kind_changed',false,'counterparty','Orion Parcerias (fictícia)','area','Comercial',
     'missing','[]'::jsonb,'ai',true,'suggested_at', now() - interval '9 days','decision','edited','decided_at', now() - interval '9 days')),
  ('00000000-0000-4000-d000-000000000006'::uuid, 6, null, 'outro',
   'Dúvida sobre assinatura eletrônica', null,
   'Vale assinatura pelo DocuSign para contrato com órgão público?',
   'normal', 4, 'cancelado', false, null, null)
)
insert into public.legal_requests
  (id, number, org_id, project_id, requester_id, requester_email, requester_name, kind, title, counterparty,
   context, urgency, due_at, status, assignee_id, assigned_at, summary, triage, delivered_at, delivery, source,
   created_at, updated_at)
select r.id, r.num, '00000000-0000-4000-c000-000000000001', r.project_id, sol.id, sol.email, 'Solicitante Demo',
       r.kind, r.title, r.counterparty, r.context, r.urgency, now() + make_interval(days => r.due_days), r.status,
       case when r.assigned then legal.id end, case when r.assigned then now() - interval '2 days' end,
       r.summary, r.triage,
       case when r.status = 'entregue' then now() - interval '4 days' end,
       case when r.status = 'entregue' then jsonb_build_object('note', 'Minuta final anexada ao card (texto sintético).') end,
       jsonb_build_object('channel', case when r.num in (1, 3) then 'slack' else 'form' end),
       now() - make_interval(days => 10 - r.num), now() - make_interval(hours => r.num)
from reqs r cross join legal cross join sol
on conflict (id) do nothing;

select setval('public.legal_request_number_seq', greatest(6, (select max(number) from public.legal_requests)));

-- Pergunta do Legal e resposta pendente no pedido "aguardando solicitante".
with legal as (select id, email from public._seed_users where role = 'legal')
insert into public.legal_request_messages (id, request_id, author_id, author_email, author_name, kind, body, created_at)
select v.id, '00000000-0000-4000-d000-000000000003', legal.id, legal.email, 'Legal Demo', v.kind, v.body, now() - v.ago
from legal cross join (values
  ('00000000-0000-4000-d100-000000000001'::uuid, 'question',
   'Quais campos entram no experimento (só e-mail ou também histórico de transações)? E vocês já têm opt-in?', interval '2 days')
) as v(id, kind, body, ago)
on conflict (id) do nothing;

-- Radar: uma varredura do time (preset BCB) e uma pessoal (LGPD), com achados
-- de impacto alto/médio/baixo cruzados com os contratos vigentes do seed.
with legal as (select id from public._seed_users where role = 'legal')
insert into public.regulatory_scans
  (id, user_id, org_id, name, preset, sources, issuers, keywords, topics, enabled, last_run_at)
select v.id, legal.id, v.org, v.name, v.preset, v.sources, v.issuers, v.keywords, v.topics, true, now() - interval '3 hours'
from legal cross join (values
  ('00000000-0000-4000-e000-000000000001'::uuid, '00000000-0000-4000-c000-000000000001'::uuid,
   'BCB — pagamentos, cripto e câmbio', 'bcb_pagamentos_cripto',
   array['bcb_normativos','dou'], array['Banco Central do Brasil','Conselho Monetário Nacional'],
   array['Pix','ativos virtuais','câmbio','instituição de pagamento'], array['psp','cripto','cambio']),
  ('00000000-0000-4000-e000-000000000002'::uuid, null::uuid,
   'LGPD e PLD (pessoal)', null,
   array['dou','rfb_noticias'], array[]::text[],
   array['dados pessoais','ANPD','lavagem de dinheiro'], array['lgpd','pld'])
) as v(id, org, name, preset, sources, issuers, keywords, topics)
on conflict (id) do nothing;

insert into public.regulatory_changes
  (id, scan_id, source, external_id, title, act_type, issuer, published_at, url, excerpt, summary, summary_quote,
   impact, impact_reason, effective_date, topics, matched_terms, affected, suggested_action, status, starred)
values
  ('00000000-0000-4000-e100-000000000001', '00000000-0000-4000-e000-000000000001', 'bcb_normativos', 'seed-res-bcb-9001',
   'Resolução BCB nº 9.001 (fictícia) — prazo de liquidação de Pix por PSP', 'Resolução BCB', 'Banco Central do Brasil',
   current_date - 2, 'https://example.invalid/radar/res-bcb-9001',
   'Altera o prazo máximo de liquidação de transações Pix por participantes indiretos (texto sintético).',
   'Reduz o prazo de liquidação de Pix para participantes indiretos e exige relatório mensal ao BCB.',
   '"o prazo de liquidação passa a ser de até 10 segundos" (texto sintético)',
   'alto', 'Ato normativo sobre PSP que cita termo presente em 2 contratos vigentes.', current_date + 60,
   array['psp'], array['Pix','prazo de liquidação'],
   jsonb_build_array(
     jsonb_build_object('project_id','00000000-0000-4000-a000-000000000012','term','Pix','quote','Cláusula 4.2 — liquidação via Pix em D+0 (sintética)'),
     jsonb_build_object('project_id','00000000-0000-4000-a000-000000000010','term','prazo de liquidação','quote','Anexo I — SLA de liquidação (sintético)')),
   'Abrir pedido de revisão do contrato com a Zeta Bank antes da vigência.', 'nova', true),
  ('00000000-0000-4000-e100-000000000002', '00000000-0000-4000-e000-000000000001', 'dou', 'seed-dou-circ-123',
   'Circular nº 123 (fictícia) — reporte de operações de câmbio', 'Circular', 'Banco Central do Brasil',
   current_date - 5, 'https://example.invalid/radar/circ-123',
   'Atualiza campos do reporte de operações de câmbio (texto sintético).',
   'Novos campos obrigatórios no reporte de câmbio; não cita contratos vigentes.',
   null, 'medio', 'Ato normativo do emissor acompanhado, sem contrato afetado.', current_date + 30,
   array['cambio'], array['câmbio'], '[]'::jsonb,
   'Avisar Operações sobre os novos campos.', 'lida', false),
  ('00000000-0000-4000-e100-000000000003', '00000000-0000-4000-e000-000000000001', 'bcb_normativos', 'seed-com-bcb-77',
   'Comunicado nº 77 (fictício) — consulta pública sobre ativos virtuais', 'Comunicado', 'Banco Central do Brasil',
   current_date - 8, 'https://example.invalid/radar/com-77',
   'Abre consulta pública sobre prestadores de serviços de ativos virtuais (texto sintético).',
   'Consulta pública aberta por 60 dias; sem efeito imediato.',
   null, 'baixo', 'Comunicado, não normativo.', null,
   array['cripto'], array['ativos virtuais'], '[]'::jsonb,
   null, 'nova', false),
  ('00000000-0000-4000-e100-000000000004', '00000000-0000-4000-e000-000000000002', 'dou', 'seed-dou-anpd-5',
   'Resolução CD/ANPD nº 50 (fictícia) — prazo de comunicação de incidente', 'Resolução', 'Autoridade Nacional de Proteção de Dados',
   current_date - 1, 'https://example.invalid/radar/anpd-50',
   'Fixa prazo de comunicação de incidente de segurança com dados pessoais (texto sintético).',
   'Encurta o prazo de comunicação de incidente; o contrato de dados com a DataVale prevê prazo maior.',
   '"comunicar em até 2 dias úteis" (texto sintético)',
   'alto', 'Ato normativo LGPD que conflita com cláusula de um contrato em negociação.', current_date + 90,
   array['lgpd'], array['dados pessoais','incidente'],
   jsonb_build_array(jsonb_build_object('project_id','00000000-0000-4000-a000-000000000007','term','incidente','quote','Cláusula 8.3 — notificação em até 5 dias (sintética)')),
   'Ajustar a cláusula 8.3 na negociação com a DataVale.', 'nova', false)
on conflict (scan_id, source, external_id) do nothing;

-- Execuções de agente e o log humano+agente dos cards (Início, ActivityFeed, custo).
insert into public.agent_runs
  (id, org_id, project_id, agent, agent_version, status, dedupe_key, model_alias, model_resolved,
   tokens_in, tokens_out, cost_usd, latency_ms, output, started_at, finished_at)
values
  ('00000000-0000-4000-f000-000000000001', '00000000-0000-4000-c000-000000000001', '00000000-0000-4000-a000-000000000001',
   'triagem', '1', 'succeeded', 'seed:triage:1', 'mike-extract', 'seed-model', 1200, 180, 0.00420, 2100,
   '{"kind":"nda","missing":2}'::jsonb, now() - interval '21 minutes', now() - interval '20 minutes'),
  ('00000000-0000-4000-f000-000000000002', '00000000-0000-4000-c000-000000000001', '00000000-0000-4000-a000-000000000004',
   'risco', '1', 'needs_human', 'seed:risco:4', 'mike-reason', 'seed-model', 8400, 950, 0.03100, 9800,
   '{"risk":"alto","clauses":3}'::jsonb, now() - interval '1 day', now() - interval '1 day' + interval '10 seconds'),
  ('00000000-0000-4000-f000-000000000003', '00000000-0000-4000-c000-000000000001', '00000000-0000-4000-a000-000000000007',
   'extrator', '1', 'failed', null, 'mike-extract', 'seed-model', 300, 0, 0.00050, 30000,
   null, now() - interval '5 hours', now() - interval '5 hours' + interval '30 seconds')
on conflict (id) do nothing;

-- card_events não tem id fixo (identity) e é append-only: só insere se o card
-- ainda não tem eventos do seed.
with legal as (select id::text as uid from public._seed_users where role = 'legal')
insert into public.card_events (org_id, project_id, at, actor_type, actor_id, actor_name, action, field, before, after, run_id, source)
select '00000000-0000-4000-c000-000000000001', v.pid, now() - v.ago, v.atype,
       case when v.atype = 'user' then legal.uid else v.actor end, v.aname, v.action, v.field, v.before, v.after, v.run, v.src
from legal cross join (values
  ('00000000-0000-4000-a000-000000000001'::uuid, interval '25 minutes', 'hermes', 'hermes:docbot', 'Hermes (Slack)', 'request.created', null, null::jsonb, null::jsonb, null::uuid, 'mcp'),
  ('00000000-0000-4000-a000-000000000001'::uuid, interval '20 minutes', 'agent', 'agent:triagem@1', 'Agente de triagem', 'agent.suggested', 'triage', null, '{"kind":"nda"}'::jsonb, '00000000-0000-4000-f000-000000000001'::uuid, 'agent'),
  ('00000000-0000-4000-a000-000000000003'::uuid, interval '2 days', 'user', null, 'Legal Demo', 'lane.changed', 'lane', '"entrada"'::jsonb, '"triagem"'::jsonb, null, 'ui'),
  ('00000000-0000-4000-a000-000000000004'::uuid, interval '1 day', 'agent', 'agent:risco@1', 'Agente de risco', 'agent.suggested', 'risk_level', null, '"alto"'::jsonb, '00000000-0000-4000-f000-000000000002'::uuid, 'agent'),
  ('00000000-0000-4000-a000-000000000004'::uuid, interval '20 hours', 'user', null, 'Legal Demo', 'field.updated', 'status', '"em_andamento"'::jsonb, '"bloqueado"'::jsonb, null, 'ui'),
  ('00000000-0000-4000-a000-000000000007'::uuid, interval '5 hours', 'agent', 'agent:extrator@1', 'Agente extrator', 'agent.failed', null, null, null, '00000000-0000-4000-f000-000000000003'::uuid, 'agent'),
  ('00000000-0000-4000-a000-000000000009'::uuid, interval '3 hours', 'user', null, 'Legal Demo', 'lane.changed', 'lane', '"negociacao"'::jsonb, '"assinatura"'::jsonb, null, 'ui'),
  ('00000000-0000-4000-a000-000000000012'::uuid, interval '3 hours', 'system', 'cron:radar', 'Radar regulatório', 'regulatory.matched', null, null, '{"change":"Resolução BCB nº 9.001 (fictícia)"}'::jsonb, null, 'cron')
) as v(pid, ago, atype, actor, aname, action, field, before, after, run, src)
where not exists (select 1 from public.card_events e where e.project_id = v.pid and e.actor_name = v.aname and e.action = v.action);

commit;
