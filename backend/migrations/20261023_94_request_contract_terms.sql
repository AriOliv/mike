-- Migration date: 2026-10-23
--
-- Part 2 of asking the legal team, "the contract" (U-05, U-07, U-08): the
-- other party's e-mail, when the contract starts and for how many months.
-- The end date is computed from the two (term_end), never stored.
--
-- counterparty_email is only kept, for the external validation by link
-- (U-16) that comes later. Nothing is sent to that address; it stays out of
-- notifications, the card's activity and the MCP tools.
--
-- All three are optional: a request without a contract file (an NDA, a
-- question) leaves them empty.

alter table public.legal_requests
  add column if not exists counterparty_email text,
  add column if not exists term_start date,
  add column if not exists term_months integer;

alter table public.legal_requests
  drop constraint if exists legal_requests_term_months_check;
alter table public.legal_requests
  add constraint legal_requests_term_months_check
    check (term_months is null or (term_months >= 1 and term_months <= 600));
