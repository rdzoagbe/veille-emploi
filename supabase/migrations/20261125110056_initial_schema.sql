-- Fresh installations only. Existing deployments must baseline their actual schema first.
create table public.subscriptions (
 id uuid primary key default gen_random_uuid(), email text not null unique,
 token uuid not null unique default gen_random_uuid(), status text not null default 'inactive',
 prefs jsonb not null default '{}', pending_prefs jsonb, confirmed_at timestamptz,
 next_run_at timestamptz, last_sent_at timestamptz, last_error text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.invite_codes (
 code text primary key, active boolean not null default true,
 max_uses integer check (max_uses > 0), uses integer not null default 0,
 created_at timestamptz not null default now()
);
create table public.invites (email text primary key, created_at timestamptz not null default now());
create table public.login_codes (
 id uuid primary key default gen_random_uuid(), email text not null, code_hash text not null,
 expires_at timestamptz not null, attempts integer not null default 0,
 created_at timestamptz not null default now()
);
create index on public.login_codes(email, created_at desc);
create table public.sessions (
 token_hash text primary key, sub_id uuid not null references public.subscriptions on delete cascade,
 created_at timestamptz not null default now(), last_seen timestamptz not null default now()
);
create table public.offers (
 id uuid primary key default gen_random_uuid(), track_id uuid not null unique default gen_random_uuid(),
 sub_id uuid not null references public.subscriptions on delete cascade, offer_key text not null,
 title text not null, company text, location text, url text, source text not null,
 posted_at timestamptz, sent_at timestamptz not null default now(), opened_at timestamptz,
 status text not null default 'new' check (status in ('new','applied','interview','rejected','notforme')),
 status_at timestamptz, unique(sub_id,offer_key)
);
create index on public.offers(sub_id,sent_at desc);
create table public.sent_offers (
 sub_id uuid not null references public.subscriptions on delete cascade, offer_key text not null,
 sent_at timestamptz not null default now(), primary key(sub_id,offer_key)
);
create table public.send_log (
 id uuid primary key default gen_random_uuid(), sub_id uuid references public.subscriptions on delete cascade,
 kind text not null, target text, offers integer, error text, sent_at timestamptz not null default now()
);
create index on public.send_log(kind,target,sent_at);
create index on public.subscriptions(next_run_at) where status = 'active';
create table public.app_config (key text primary key, value text not null);

-- The edge function authenticates custom sessions. Browser roles must never access these tables.
do $$ declare t text; begin
 foreach t in array array['subscriptions','invite_codes','invites','login_codes','sessions','offers','sent_offers','send_log','app_config'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public, anon, authenticated',t);
  execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;

create function public.claim_invite(p_email text, p_code text) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
 -- Serialize claims for the same address, including claims with different codes.
 perform pg_advisory_xact_lock(hashtextextended(p_email,0));
 if exists(select 1 from public.invites where email=p_email) then return true; end if;
 update public.invite_codes set uses=uses+1
 where code=p_code and active and (max_uses is null or uses < max_uses);
 if not found then return false; end if;
 insert into public.invites(email) values(p_email);
 return true;
end $$;
create function public.next_run(hhmm text, from_ts timestamptz) returns timestamptz
language plpgsql stable security invoker set search_path = '' as $$
declare candidate timestamptz;
begin
 candidate := ((from_ts at time zone 'Europe/Paris')::date + hhmm::time) at time zone 'Europe/Paris';
 if candidate <= from_ts then
  candidate := (((from_ts at time zone 'Europe/Paris')::date + 1) + hhmm::time) at time zone 'Europe/Paris';
 end if;
 return candidate;
end $$;
create function public.cron_secret_ok(s text) returns boolean
language sql stable security invoker set search_path = '' as $$
 select s <> '' and exists(select 1 from public.app_config where key='cron_secret' and value=s)
$$;
revoke all on function public.claim_invite(text,text), public.next_run(text,timestamptz), public.cron_secret_ok(text) from public, anon, authenticated;
grant execute on function public.claim_invite(text,text), public.next_run(text,timestamptz), public.cron_secret_ok(text) to service_role;
