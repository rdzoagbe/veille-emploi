-- Additive upgrade for existing deployments; compatible with bigint and uuid login-code IDs.
alter table public.login_codes add column if not exists consumed_at timestamptz;
create index if not exists login_codes_created_at_idx on public.login_codes(created_at);

-- Keep browser roles away from the custom-session tables (the Edge Function uses service_role).
revoke all on public.login_codes, public.sessions, public.subscriptions, public.offers, public.invites, public.invite_codes, public.sent_offers, public.send_log from public, anon, authenticated;
grant all on public.login_codes, public.sessions, public.subscriptions, public.offers, public.invites, public.invite_codes, public.sent_offers, public.send_log to service_role;

-- Serialize reservation and verification across all Edge isolates. Retain consumed rows
-- for the rolling rate limit, without retaining their usable OTP hash.
create or replace function public.reserve_login_code(p_email text, p_hash text)
returns text language plpgsql security invoker set search_path = '' as $$
declare ts timestamptz := clock_timestamp();
begin
  if p_email is null or length(p_email) > 200 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
     or p_hash is null or p_hash !~ '^[0-9a-f]{64}$' then return 'bad_email'; end if;
  perform pg_advisory_xact_lock(834621, 1);
  ts := clock_timestamp();
  delete from public.login_codes where created_at < ts - interval '24 hours';
  if exists(select 1 from public.login_codes where email=p_email and created_at > ts - interval '45 seconds') then return 'wait'; end if;
  if (select count(*) from public.login_codes where email=p_email and created_at > ts - interval '1 hour') >= 6 then return 'too_many'; end if;
  if (select count(*) from public.login_codes where created_at > ts - interval '1 hour') >= 30
     or (select count(*) from public.login_codes where created_at > ts - interval '24 hours') >= 120 then return 'service_busy'; end if;
  insert into public.login_codes(email,code_hash,expires_at,created_at) values(p_email,p_hash,ts+interval '10 minutes',ts);
  return 'ok';
end $$;

create or replace function public.consume_login_code(p_email text,p_hash text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare r public.login_codes%rowtype; remaining int; ts timestamptz;
begin
  perform pg_advisory_xact_lock(834621, 1);
  ts := clock_timestamp();
  select * into r from public.login_codes where email=p_email order by created_at desc,id desc limit 1;
  if not found or r.expires_at <= ts or r.consumed_at is not null then return jsonb_build_object('status','expired'); end if;
  if r.attempts >= 5 then return jsonb_build_object('status','locked'); end if;
  if r.code_hash is distinct from p_hash then
    remaining := 4-r.attempts;
    update public.login_codes set attempts=attempts+1 where id=r.id;
    return jsonb_build_object('status',case when remaining>0 then 'bad_code' else 'locked' end,'left',remaining);
  end if;
  update public.login_codes set consumed_at=ts, code_hash=repeat('0',64) where email=p_email and consumed_at is null;
  return jsonb_build_object('status','ok');
end $$;
revoke all on function public.reserve_login_code(text,text),public.consume_login_code(text,text) from public,anon,authenticated;
grant execute on function public.reserve_login_code(text,text),public.consume_login_code(text,text) to service_role;
