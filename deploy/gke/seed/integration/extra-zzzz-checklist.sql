-- requires-table: public.legal_requests public.projects
-- Pedidos de seed que já passaram do checklist o têm como fechado.
-- A etapa que a faixa do pedido mostra é derivada (status, raia do card e
-- checklist, requests.stages.ts): com card e sem intake_completed_at o checklist
-- conta como aberto e a etapa é "Checklist, aguardando quem pediu". O seed não
-- preenchia esse campo, então toda prévia nova mostrava todos os pedidos assim.
-- Fecha o checklist de quem já foi pego pelo time (em andamento ou aguardando
-- o solicitante), tem a triagem lida ou já foi entregue. Idempotente: só toca
-- no que ainda está aberto. 100% fictício, só na prévia.
begin;

update public.legal_requests r
set intake_completed_at = coalesce(r.assigned_at, r.created_at) + interval '1 hour'
where r.project_id is not null
  and r.intake_completed_at is null
  and r.org_id = '00000000-0000-4000-c000-000000000001'
  and (r.status in ('em_andamento', 'aguardando_solicitante', 'entregue')
       or r.triage is not null);

commit;
