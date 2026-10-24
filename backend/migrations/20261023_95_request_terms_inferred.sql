-- Migration date: 2026-10-23
--
-- What the intake agent read from the contract about its terms (U-05 part
-- 2): the other party, when it starts and for how many months. It is kept
-- apart from what the requester typed (counterparty, term_start,
-- term_months) so the form can show it as "preenchido pela IA, confirme"
-- and a person's answer is never overwritten.
--
-- {counterparty?: {value, quote}, term_start?: {value, quote},
--  term_months?: {value, quote}}. A key is there only with the contract's own
-- words (quote) behind it. Confirming copies the value into the real column
-- and drops the key.

alter table public.legal_requests
  add column if not exists terms_inferred jsonb not null default '{}'::jsonb;

alter table public.legal_requests
  drop constraint if exists legal_requests_terms_inferred_check;
alter table public.legal_requests
  add constraint legal_requests_terms_inferred_check
    check (jsonb_typeof(terms_inferred) = 'object');
