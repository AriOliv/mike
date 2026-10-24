-- Migration date: 2026-10-23
--
-- Intake questions by kind of request (U-05).
--
-- legal_teams.intake_by_kind: optional map kind -> list of question keys
-- that apply to that kind, for an organization with its own checklist.
-- Without it the generic checklist is cut by the code's defaults.
--
-- legal_requests.intake_kind: the kind the checklist was last shown or
-- answered for. When the triage corrects the kind, the screen tells the
-- requester the number of questions changed (kind_changed).

alter table public.legal_teams
  add column if not exists intake_by_kind jsonb not null default '{}'::jsonb;
alter table public.legal_teams
  drop constraint if exists legal_teams_intake_by_kind_check;
alter table public.legal_teams
  add constraint legal_teams_intake_by_kind_check
    check (jsonb_typeof(intake_by_kind) = 'object');

alter table public.legal_requests
  add column if not exists intake_kind text;
