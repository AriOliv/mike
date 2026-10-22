-- Migration date: 2026-10-22
--
-- The intake checklist of a request to the legal team: what the team needs
-- to know before it analyses a contract (who approved it, the counterparty,
-- value and recurrence, confidential information, personal data...).
--
-- legal_teams.intake_template is the organization's own checklist, a list of
-- {key, label, kind, required, hint?}; empty means the generic one in the
-- code. legal_requests.intake holds the answers by key: {value, source:
-- requester | inferred, confirmed, quote?}. An inferred answer was read from
-- the attached contract by the agent and waits for the requester to confirm.
--
-- legal_requests.critical_alert_at marks the one alert per request the
-- Head gets when the contract's analysis finds a critical risk.

alter table public.legal_teams
  add column if not exists intake_template jsonb not null default '[]'::jsonb;

alter table public.legal_teams
  drop constraint if exists legal_teams_intake_template_check;
alter table public.legal_teams
  add constraint legal_teams_intake_template_check
    check (jsonb_typeof(intake_template) = 'array');

alter table public.legal_requests
  add column if not exists intake jsonb not null default '{}'::jsonb,
  add column if not exists intake_completed_at timestamptz,
  add column if not exists critical_alert_at timestamptz;

alter table public.legal_requests
  drop constraint if exists legal_requests_intake_check;
alter table public.legal_requests
  add constraint legal_requests_intake_check
    check (jsonb_typeof(intake) = 'object');

create index if not exists idx_legal_requests_org_alert
  on public.legal_requests(org_id, critical_alert_at desc)
  where critical_alert_at is not null;
