-- requires-table: public.card_events public.contract_reviews public.watched_folders public.agent_runs
-- O conteúdo do legal.demo mora no time "Avenia Legal (demo)", não no Personal:
-- com o #22 o legal abre direto no time, e o Início/Histórico têm de mostrar os
-- contratos ali (no staging os projetos reais também são do time). Roda por
-- último (extra-zzz-*), depois de todos os inserts. 100% fictício, idempotente:
-- só mexe no que ainda está no Personal. O que o app cria sozinho (memória,
-- workflow) e o radar "pessoal" ficam onde estão.

begin;

do $$
declare team constant uuid := '00000000-0000-4000-c000-000000000001';
begin
  if not exists (select 1 from public.organizations where id = team) then return; end if;

  -- cards: visibilidade de time; o trigger de grants apaga os compartilhamentos diretos
  update public.projects p set org_id = team, visibility = 'organization'
  from public._seed_users u
  where u.role = 'legal' and p.user_id = u.id and p.org_id is null
    and p.id::text like '00000000-0000-4000-a000-%';

  update public.documents d set org_id = team
  where d.org_id is null and d.project_id in (select id from public.projects where org_id = team);
  update public.contract_reviews r set org_id = team
  where r.org_id is null and r.project_id in (select id from public.projects where org_id = team);
  update public.agent_runs a set org_id = team
  where a.org_id is null and a.project_id in (select id from public.projects where org_id = team);
  update public.tabular_reviews t set org_id = team
  where t.org_id is null and t.project_id in (select id from public.projects where org_id = team);
  update public.watched_folders w set org_id = team
  where w.org_id is null and w.id = '00000000-0000-4000-f100-000000000001';
  update public.playbooks b set org_id = team, visibility = 'organization'
  where b.org_id is null and b.id = '00000000-0000-4000-b100-000000000001';

  -- card_events é append-only (trigger); só o seed, como dono da tabela, abre a
  -- exceção para carimbar a org nos eventos sintéticos destes cards
  alter table public.card_events disable trigger trg_card_events_no_update;
  update public.card_events e set org_id = team
  where e.org_id is null and e.project_id in (select id from public.projects where org_id = team);
  alter table public.card_events enable trigger trg_card_events_no_update;
end $$;

-- o solicitante vê só os pedidos dele: nenhum card do legal compartilhado
delete from public.project_access_grants g
using public.projects p
where g.project_id = p.id and p.id::text like '00000000-0000-4000-a000-%'
  and g.email = 'solicitante.demo@avenia.io';

commit;
