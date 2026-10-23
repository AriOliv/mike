-- Migration date: 2026-10-23
--
-- Assignment rules of the legal team (L-33): fixed, predictable, no model.
-- legal_teams.assignment_rules is an ordered list of
-- {when: {area?, kind?, value_min?, value_max?}, assign_to, note?}; the first
-- rule that matches a request names who takes it. Empty means no rule: the
-- triage agent's suggestion (open load) decides, as before.
--
-- legal_requests.assigned_by records how the current assignee was set:
-- 'rule' (a rule above), 'triage' (the Head accepted or auto-assign applied
-- the agent's suggestion) or 'person'. Only a rule's own assignment may be
-- replaced by a later rule; a person's choice is never undone.

alter table public.legal_teams
  add column if not exists assignment_rules jsonb not null default '[]'::jsonb;

alter table public.legal_teams
  drop constraint if exists legal_teams_assignment_rules_check;
alter table public.legal_teams
  add constraint legal_teams_assignment_rules_check
    check (jsonb_typeof(assignment_rules) = 'array');

alter table public.legal_requests
  add column if not exists assigned_by text;

alter table public.legal_requests
  drop constraint if exists legal_requests_assigned_by_check;
alter table public.legal_requests
  add constraint legal_requests_assigned_by_check
    check (assigned_by is null or assigned_by in ('rule', 'triage', 'person'));
