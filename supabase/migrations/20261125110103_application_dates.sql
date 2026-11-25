-- Safe additive upgrade; historical automatic/forwarded dates remain unknown.
alter table public.offers add column if not exists applied_at timestamptz;
update public.offers set applied_at=sent_at
where applied_at is null and source='manual' and status in ('applied','interview','rejected');

-- Atomic preservation avoids overwriting the original date on subsequent status changes.
-- Inserts from forwarded mail deliberately keep an unknown date: forwarding time is not application time.
create or replace function public.preserve_application_date() returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
 if old.applied_at is not null then
  new.applied_at := old.applied_at;

 end if;
 return new;
end $$;
revoke all on function public.preserve_application_date() from public, anon, authenticated;
drop trigger if exists offers_application_date on public.offers;
create trigger offers_application_date before update on public.offers
for each row execute function public.preserve_application_date();
