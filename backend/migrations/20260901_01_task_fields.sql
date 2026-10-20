-- Migration date: 2026-09-01
-- Task-shaped fields on pipeline cards, mirrored to the Notion board so the
-- legal team tracks progress there with the attributes they already know.
--
-- Etapa (lane) and Risco already exist. These are the task-management fields
-- plus contract_type, which the analysis now classifies (a derived field, like
-- risk). Status is a second axis, independent of the lane: a contract can be
-- "Bloqueado" without changing which stage it sits in.
alter table public.projects
  add column if not exists status text,          -- a_fazer | em_andamento | bloqueado | concluido
  add column if not exists assignee_email text,
  add column if not exists priority text,        -- baixa | media | alta
  add column if not exists deadline date,
  add column if not exists completed_at date,
  add column if not exists contract_type text;   -- classified in analysis (derived)

-- Give existing cards a sensible starting Status so the board is not blank:
-- archived contracts read as done, everything else as in progress. Priority
-- stays null until someone sets it.
update public.projects
  set status = case when lane = 'arquivado' then 'concluido' else 'em_andamento' end
  where lane is not null and status is null;
