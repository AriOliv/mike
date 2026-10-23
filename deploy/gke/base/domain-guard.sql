-- Only @avenia.io may exist as an auth user. GoTrue creates the row on first
-- login (password signup or Google OAuth); this guard rejects anything else,
-- so the restriction holds no matter what the client sends (a forged `hd`, a
-- direct API call, a non-Workspace Google account).
create or replace function public.enforce_avenia_domain()
returns trigger language plpgsql as $$
begin
  if new.email is null or lower(new.email) not like '%@avenia.io' then
    raise exception 'signup restricted to @avenia.io addresses';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_avenia_domain on auth.users;
create trigger trg_enforce_avenia_domain
  before insert on auth.users
  for each row execute function public.enforce_avenia_domain();
