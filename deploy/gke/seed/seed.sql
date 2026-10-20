-- Seed sintético para staging/prévias (deploy/gke/seed/seed-job.yaml).
-- 100% fictício: nenhuma contraparte, valor ou pessoa real. Contrapartes usam o
-- sufixo "(fictícia)" de propósito, para ninguém confundir com dado de prod.
-- Idempotente: ids fixos + on conflict do nothing. Datas relativas a current_date
-- para o Vigia de prazos sempre ter algo vencendo em 7/30/90 dias.
-- Pré-requisito: public._seed_users preenchida pelo seed job (GoTrue admin API).
-- Os PDFs correspondentes são gerados de seed/contracts/*.md (fora deste rascunho)
-- e enviados pelo endpoint normal de upload; aqui ficam card, termos e prazos.

begin;

with legal as (select id as uid from public._seed_users where role = 'legal'),
cards(id, name, counterparty, lane, status, priority, risk, ctype, requester, deadline_days) as (
  values
  ('00000000-0000-4000-a000-000000000001'::uuid, 'NDA — Acme Pagamentos',            'Acme Pagamentos (fictícia)',      'entrada',    'a_fazer',      'media', null,    'nda',               'Solicitante Demo', 5),
  ('00000000-0000-4000-a000-000000000002'::uuid, 'Prestação de serviços — Delta TI', 'Delta TI Ltda (fictícia)',        'entrada',    'a_fazer',      'alta',  null,    'prestacao_servicos','Solicitante Demo', 2),
  ('00000000-0000-4000-a000-000000000003'::uuid, 'SaaS — Nuvem Contábil',            'Nuvem Contábil S.A. (fictícia)',  'triagem',    'em_andamento', 'media', 'medio', 'saas',              'Solicitante Demo', 10),
  ('00000000-0000-4000-a000-000000000004'::uuid, 'Parceria comercial — Orion',       'Orion Parcerias (fictícia)',      'triagem',    'bloqueado',    'alta',  'alto',  'parceria',          'Solicitante Demo', 3),
  ('00000000-0000-4000-a000-000000000005'::uuid, 'Locação de escritório — Ed. Sol',  'Imobiliária Sol (fictícia)',      'revisao',    'em_andamento', 'baixa', 'baixo', 'locacao',           'Solicitante Demo', 20),
  ('00000000-0000-4000-a000-000000000006'::uuid, 'Aditivo — Delta TI',               'Delta TI Ltda (fictícia)',        'revisao',    'a_fazer',      'media', 'medio', 'aditivo',           'Solicitante Demo', 7),
  ('00000000-0000-4000-a000-000000000007'::uuid, 'Contrato de dados — DataVale',     'DataVale Analytics (fictícia)',   'negociacao', 'em_andamento', 'alta',  'alto',  'tratamento_dados',  'Solicitante Demo', 4),
  ('00000000-0000-4000-a000-000000000008'::uuid, 'Distrato — Gama Eventos',          'Gama Eventos (fictícia)',         'negociacao', 'a_fazer',      'baixa', 'baixo', 'distrato',          'Solicitante Demo', 15),
  ('00000000-0000-4000-a000-000000000009'::uuid, 'Licença de software — Kappa',      'Kappa Software (fictícia)',       'assinatura', 'em_andamento', 'media', 'medio', 'licenca',           'Solicitante Demo', 1),
  ('00000000-0000-4000-a000-000000000010'::uuid, 'SaaS — Atlas CRM (vigente)',       'Atlas CRM (fictícia)',            'arquivado',  'concluido',    null,    'medio', 'saas',              'Solicitante Demo', null),
  ('00000000-0000-4000-a000-000000000011'::uuid, 'Prestação — Beta Limpeza (vig.)',  'Beta Limpeza (fictícia)',         'arquivado',  'concluido',    null,    'baixo', 'prestacao_servicos','Solicitante Demo', null),
  ('00000000-0000-4000-a000-000000000012'::uuid, 'Parceria — Zeta Bank (vigente)',   'Zeta Bank (fictícia)',            'arquivado',  'concluido',    null,    'alto',  'parceria',          'Solicitante Demo', null)
)
insert into public.projects
  (id, user_id, name, counterparty, lane, status, priority, risk_level, contract_type,
   requester_name, deadline, lane_updated_at)
select c.id, legal.uid, c.name, c.counterparty, c.lane, c.status, c.priority, c.risk, c.ctype,
       c.requester,
       case when c.deadline_days is null then null else current_date + c.deadline_days end,
       now() - (random() * interval '10 days')
from cards c cross join legal
on conflict (id) do nothing;

-- O solicitante vê os cards como editor (compartilhamento direto, projetos pessoais).
insert into public.project_access_grants (project_id, email, role, created_by)
select p.id, 'solicitante.demo@avenia.io', 'editor', p.user_id
from public.projects p
where p.id::text like '00000000-0000-4000-a000-%'
on conflict (project_id, email) do nothing;

-- Termos dos contratos vigentes (Arquivado): exercitam renovação/aviso prévio.
with legal as (select id::text as uid from public._seed_users where role = 'legal')
insert into public.contract_terms
  (project_id, user_id, auto_renewal, term_end, notice_days, notice_deadline,
   penalty_value, penalty_recurrence, liability_cap, unilateral_amendment, sources)
select v.pid, legal.uid, v.auto_renewal, v.term_end, v.notice_days, v.term_end - v.notice_days,
       v.penalty, v.rec, v.cap, v.unilateral,
       jsonb_build_object(
         'auto_renewal', 'Cláusula 12.1 — "renovar-se-á automaticamente por iguais períodos" (texto sintético)',
         'notice_days',  'Cláusula 12.2 — "mediante aviso prévio por escrito" (texto sintético)')
from legal cross join (values
  ('00000000-0000-4000-a000-000000000010'::uuid, true,  current_date + 37,  30, '10% do valor anual', 'unica',      '12 mensalidades', false),
  ('00000000-0000-4000-a000-000000000011'::uuid, true,  current_date + 97,  90, 'R$ 5.000,00',        'por_evento', null,              false),
  ('00000000-0000-4000-a000-000000000012'::uuid, false, current_date + 8,   0,  '20% do valor total', 'unica',      'valor do contrato', true)
) as v(pid, auto_renewal, term_end, notice_days, penalty, rec, cap, unilateral)
on conflict (project_id) do nothing;

-- Prazos: um de cada tipo vencendo em 1, 7, 30 e 90 dias + um atrasado.
with legal as (select id::text as uid from public._seed_users where role = 'legal')
insert into public.obligations (id, user_id, project_id, title, mark, due_date, origin, source_quote)
select v.id, legal.uid, v.pid, v.title, v.mark, current_date + v.days, v.origin, v.quote
from legal cross join (values
  ('00000000-0000-4000-b000-000000000001'::uuid, '00000000-0000-4000-a000-000000000010'::uuid, 'Decidir renovação — Atlas CRM',          'critico',    7,  'renewal', 'Cláusula 12.2 (sintética)'),
  ('00000000-0000-4000-b000-000000000002'::uuid, '00000000-0000-4000-a000-000000000011'::uuid, 'Aviso prévio — Beta Limpeza',            'critico',    7,  'renewal', 'Cláusula 9.1 (sintética)'),
  ('00000000-0000-4000-b000-000000000003'::uuid, '00000000-0000-4000-a000-000000000012'::uuid, 'Relatório trimestral de SLA — Zeta Bank', 'recorrente', 30, 'manual',  'Anexo II, item 3 (sintético)'),
  ('00000000-0000-4000-b000-000000000004'::uuid, '00000000-0000-4000-a000-000000000012'::uuid, 'Fim de vigência — Zeta Bank',            'critico',    8,  'renewal', 'Cláusula 3.1 (sintética)'),
  ('00000000-0000-4000-b000-000000000005'::uuid, '00000000-0000-4000-a000-000000000009'::uuid, 'Coletar assinaturas — Kappa',            'tarefa',     1,  'manual',  null),
  ('00000000-0000-4000-b000-000000000006'::uuid, '00000000-0000-4000-a000-000000000011'::uuid, 'Reajuste anual IPCA — Beta Limpeza',     'recorrente', 90, 'manual',  'Cláusula 5.3 (sintética)'),
  ('00000000-0000-4000-b000-000000000007'::uuid, '00000000-0000-4000-a000-000000000007'::uuid, 'Retorno da contraparte — DataVale',      'tarefa',    -2,  'manual',  null)
) as v(id, pid, title, mark, days, origin, quote)
on conflict (id) do nothing;

commit;
