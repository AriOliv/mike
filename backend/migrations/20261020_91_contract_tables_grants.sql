-- Migration date: 2026-10-20
--
-- Give the backend's service_role the data privileges on the fork's contract
-- tables. A fresh install gets them from schema.sql's one-shot
-- `grant ... on all tables in schema public to service_role`; an upgraded
-- database created these tables in the 20260808_* migrations, after that grant
-- had run, so it never saw them. Same pattern as the other late tables: browser
-- roles get nothing (the backend fronts all access). Idempotent.

revoke all on public.obligations from anon, authenticated;
revoke all on public.dossiers from anon, authenticated;
revoke all on public.contract_terms from anon, authenticated;
revoke all on public.app_settings from anon, authenticated;

grant select, insert, update, delete
  on public.obligations, public.dossiers, public.contract_terms, public.app_settings
  to service_role;
