-- requires-table: public.watched_folders public.contract_reviews public.home_visits
-- Seed sintético do Início (auto-revisão de pastas monitoradas) para a prévia.
-- 100% fictício. Roda depois do seed base (seed.sql): pendura revisões nos
-- cards 00000000-0000-4000-a000-0000000000NN e usa public._seed_users.
-- Idempotente: ids fixos, on conflict do nothing; card_events é append-only,
-- então cada evento entra só se ainda não existe (where not exists).
-- Os documentos não têm arquivo no storage: a tela mostra o nome, o semáforo e
-- o resumo; "Revisar de novo" num destes falha com a mensagem de arquivo
-- ilegível, que é o comportamento certo.
-- Namespaces próprios: f1 pasta · d1 documentos · e1 versões · c1 revisões.

begin;

-- A pasta monitorada, revisada com o primeiro playbook visível ao Legal (se houver).
with legal as (select id from public._seed_users where role = 'legal')
insert into public.watched_folders (id, created_by, name, source, default_assignee_email)
select '00000000-0000-4000-f100-000000000001'::uuid, legal.id, 'Contratos recebidos (fictícia)', 'upload',
       'legal.demo@avenia.io'
from legal
on conflict (id) do nothing;

update public.projects
set watched_folder_id = '00000000-0000-4000-f100-000000000001'
where id in (
  '00000000-0000-4000-a000-000000000003', '00000000-0000-4000-a000-000000000004',
  '00000000-0000-4000-a000-000000000005', '00000000-0000-4000-a000-000000000006',
  '00000000-0000-4000-a000-000000000007', '00000000-0000-4000-a000-000000000010')
  and watched_folder_id is null;

-- Um documento e uma versão "enviada" por card.
with legal as (select id from public._seed_users where role = 'legal'),
docs(n, pid, filename) as (values
  (1, '00000000-0000-4000-a000-000000000003'::uuid, 'SaaS Nuvem Contábil (fictícia).docx'),
  (2, '00000000-0000-4000-a000-000000000004'::uuid, 'Parceria Orion (fictícia).docx'),
  (3, '00000000-0000-4000-a000-000000000005'::uuid, 'Locação Ed. Sol (fictícia).pdf'),
  (4, '00000000-0000-4000-a000-000000000006'::uuid, 'Aditivo Delta TI (fictícia).docx'),
  (5, '00000000-0000-4000-a000-000000000007'::uuid, 'Contrato de dados DataVale (fictícia).docx'),
  (6, '00000000-0000-4000-a000-000000000010'::uuid, 'SaaS Atlas CRM (fictícia).pdf')
)
insert into public.documents (id, project_id, user_id, status)
select ('00000000-0000-4000-d100-00000000000' || d.n)::uuid, d.pid, legal.id, 'ready'
from docs d cross join legal
on conflict (id) do nothing;

with docs(n, filename) as (values
  (1, 'SaaS Nuvem Contábil (fictícia).docx'),
  (2, 'Parceria Orion (fictícia).docx'),
  (3, 'Locação Ed. Sol (fictícia).pdf'),
  (4, 'Aditivo Delta TI (fictícia).docx'),
  (5, 'Contrato de dados DataVale (fictícia).docx'),
  (6, 'SaaS Atlas CRM (fictícia).pdf')
)
insert into public.document_versions (id, document_id, storage_path, filename, version_number, source, file_type)
select ('00000000-0000-4000-e100-00000000000' || d.n)::uuid,
       ('00000000-0000-4000-d100-00000000000' || d.n)::uuid,
       'seed/inicio/' || d.n, d.filename, 1, 'upload',
       case when d.filename like '%.pdf' then 'pdf' else 'docx' end
from docs d
on conflict (id) do nothing;

update public.documents d
set current_version_id = ('00000000-0000-4000-e100-00000000000' || right(d.id::text, 1))::uuid
where d.id::text like '00000000-0000-4000-d100-%' and d.current_version_id is null;

-- Revisões em todos os estados que a tela mostra.
with legal as (select id from public._seed_users where role = 'legal')
insert into public.contract_reviews
  (id, project_id, document_id, version_id, watched_folder_id, status, step, requested_by,
   assignee_email, aligned, needs_review, deviates, summary, error,
   created_at, updated_at, finished_at, decided_by, decided_at)
select v.id, v.pid, v.did, v.vid, '00000000-0000-4000-f100-000000000001', v.status, v.step, legal.id,
       v.assignee, v.al, v.nr, v.dv, v.summary, v.error,
       now() - v.created, now() - v.updated,
       case when v.status in ('ready', 'done') then now() - v.updated end,
       case when v.status = 'done' then legal.id end,
       case when v.status = 'done' then now() - v.updated end
from legal cross join (values
  ('00000000-0000-4000-c100-000000000001'::uuid, '00000000-0000-4000-a000-000000000004'::uuid,
   '00000000-0000-4000-d100-000000000002'::uuid, '00000000-0000-4000-e100-000000000002'::uuid,
   'ready', null, 'legal.demo@avenia.io', 8, 6, 3,
   'Três desvios do playbook: exclusividade sem prazo (cl. 4), multa rescisória de 50% do valor total (cl. 11) e foro fora de São Paulo (cl. 15). Confidencialidade e LGPD alinhadas.',
   null, interval '3 hours', interval '35 minutes'),
  ('00000000-0000-4000-c100-000000000002'::uuid, '00000000-0000-4000-a000-000000000007'::uuid,
   '00000000-0000-4000-d100-000000000005'::uuid, '00000000-0000-4000-e100-000000000005'::uuid,
   'running', 'playbook', null, 0, 0, 0, null, null, interval '6 minutes', interval '1 minute'),
  ('00000000-0000-4000-c100-000000000003'::uuid, '00000000-0000-4000-a000-000000000006'::uuid,
   '00000000-0000-4000-d100-000000000004'::uuid, '00000000-0000-4000-e100-000000000004'::uuid,
   'queued', null, null, 0, 0, 0, null, null, interval '2 minutes', interval '2 minutes'),
  ('00000000-0000-4000-c100-000000000004'::uuid, '00000000-0000-4000-a000-000000000005'::uuid,
   '00000000-0000-4000-d100-000000000003'::uuid, '00000000-0000-4000-e100-000000000003'::uuid,
   'ready', null, 'legal.demo@avenia.io', 12, 2, 0,
   'Alinhado ao playbook de locação; conferir o reajuste pelo IGP-M (cl. 6) e a garantia por seguro-fiança (cl. 9).',
   null, interval '1 day', interval '20 hours'),
  ('00000000-0000-4000-c100-000000000005'::uuid, '00000000-0000-4000-a000-000000000010'::uuid,
   '00000000-0000-4000-d100-000000000006'::uuid, '00000000-0000-4000-e100-000000000006'::uuid,
   'done', null, 'legal.demo@avenia.io', 10, 1, 1,
   'SaaS com renovação automática; aviso prévio de 30 dias e multa de 10% do valor anual.',
   null, interval '3 days', interval '2 days'),
  ('00000000-0000-4000-c100-000000000006'::uuid, '00000000-0000-4000-a000-000000000003'::uuid,
   '00000000-0000-4000-d100-000000000001'::uuid, '00000000-0000-4000-e100-000000000001'::uuid,
   'failed', null, null, 0, 0, 0, null, 'Não consegui ler este contrato. Tente de novo.',
   interval '6 hours', interval '5 hours')
) as v(id, pid, did, vid, status, step, assignee, al, nr, dv, summary, error, created, updated)
on conflict (id) do nothing;

-- Atividade de pessoas e agentes nesses cards.
with legal as (select id::text as uid from public._seed_users where role = 'legal'),
ev(pid, ago, actor_type, actor_id, actor_name, action, after) as (values
  ('00000000-0000-4000-a000-000000000004'::uuid, interval '3 hours', 'hermes', 'hermes:docbot', 'Assistente no Slack',
   'request.created', '{"request":"LEG-0142"}'::jsonb),
  ('00000000-0000-4000-a000-000000000004'::uuid, interval '170 minutes', 'agent', 'agent:atribuicao', 'Agente de atribuição',
   'assignee.changed', '{"steps":["Contou os cards abertos de cada pessoa","Parceria vai para quem tem menos carga"],"confirmed_by":"Legal Demo"}'::jsonb),
  ('00000000-0000-4000-a000-000000000004'::uuid, interval '35 minutes', 'agent', 'agent:revisor@1', 'Agente de revisão',
   'review.completed', '{"document":"Parceria Orion (fictícia).docx","sources":3}'::jsonb),
  ('00000000-0000-4000-a000-000000000005'::uuid, interval '20 hours', 'agent', 'agent:revisor@1', 'Agente de revisão',
   'review.completed', '{"document":"Locação Ed. Sol (fictícia).pdf","sources":5}'::jsonb),
  ('00000000-0000-4000-a000-000000000007'::uuid, interval '6 minutes', 'agent', 'agent:revisor@1', 'Agente de revisão',
   'review.started', '{"document":"Contrato de dados DataVale (fictícia).docx"}'::jsonb),
  ('00000000-0000-4000-a000-000000000003'::uuid, interval '5 hours', 'agent', 'agent:revisor@1', 'Agente de revisão',
   'review.failed', null::jsonb)
)
insert into public.card_events (project_id, at, actor_type, actor_id, actor_name, action, after)
select ev.pid, now() - ev.ago, ev.actor_type, ev.actor_id, ev.actor_name, ev.action, ev.after
from ev
where not exists (
  select 1 from public.card_events c
  where c.project_id = ev.pid and c.action = ev.action and c.actor_id = ev.actor_id
);

-- Termos com aviso prévio em 30 dias para os cards em revisão (o vigente já vem do seed base).
with legal as (select id::text as uid from public._seed_users where role = 'legal')
insert into public.contract_terms (project_id, user_id, auto_renewal, term_end, notice_days, notice_deadline, penalty_value, sources)
select v.pid, legal.uid, v.auto, current_date + v.end_days, v.notice, current_date + v.end_days - v.notice, v.penalty,
       '{"notice_days":"Cláusula de vigência (texto sintético)"}'::jsonb
from legal cross join (values
  ('00000000-0000-4000-a000-000000000004'::uuid, true, 72, 60, '50% do valor total'),
  ('00000000-0000-4000-a000-000000000005'::uuid, true, 150, 90, '3 aluguéis')
) as v(pid, auto, end_days, notice, penalty)
on conflict (project_id) do nothing;

-- O Legal abriu o Início pela última vez ontem: a saudação conta o que veio depois.
insert into public.home_visits (user_id, previous_seen_at, last_seen_at)
select id, now() - interval '2 days', now() - interval '1 day'
from public._seed_users where role = 'legal'
on conflict (user_id) do nothing;

commit;
