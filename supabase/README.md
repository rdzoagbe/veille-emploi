# Database setup

These files reconstruct the schema required by the checked-in backend. They are not a dump
of the live project, which was not inspected or modified.

## Fresh project

1. In a new Supabase project, run `migrations/*_initial_schema.sql` then
   `migrations/*_application_dates.sql`, in filename order, using the SQL editor.
2. Set the function secrets listed in the root README. Supabase supplies its URL and service-role
   key to the deployed function. Never place the service-role key in the frontend.
3. Set `API` in `app.js` to your project's `/functions/v1/veille` URL and `APP_URL` in
   `server/veille/core.js` to your Pages URL.
4. Deploy the `veille` function. With CLI v3, use
   `supabase functions deploy veille --remote=YOUR_PROJECT_REF --no-verify-jwt --use-api`.
   The checked-in config points to the source under `server/veille/`.
5. Create an invite using the SQL below, publish the static frontend, and visit
   `https://YOUR_SITE/?i=YOUR_INVITE_CODE`.
6. Configure cron as below and verify a sign-in, a manual application, and one real alert.

```sql
insert into public.invite_codes(code,max_uses)
values ('REPLACE_WITH_RANDOM_LOWERCASE_CODE',20);
```

All app tables have RLS enabled with browser-role grants revoked. The backend authenticates
its custom sessions and uses `service_role`. Internal RPC execution is restricted to that role.
Do not add anonymous policies to make the custom login work.

## Existing deployment

Back up and inspect the existing schema first. **Do not apply the initial-schema migration to an
existing project** or mark it applied without reconciling the actual schema. It is a fresh-install
baseline, not an incremental migration of an unknown database.

For this release, apply only `*_application_dates.sql` to the existing `public.offers` table.
It adds a nullable field and a preservation trigger, and backfills only manual application dates.
Test in a staging copy, then deploy backend followed by frontend. Older backend/frontend code
can coexist with the added column during rollout, but new application dates are recorded only
by the new backend. Reverting the application code does not require dropping the column.

## Cron

Enable `pg_cron` and `pg_net` through the Supabase extensions UI. In the SQL editor, initialize
private settings with your actual function URL and a long random secret (do not commit those values):

```sql
insert into public.app_config(key,value) values
 ('function_url','https://YOUR_PROJECT_REF.supabase.co/functions/v1/veille'),
 ('cron_secret','REPLACE_WITH_LONG_RANDOM_SECRET')
on conflict(key) do update set value=excluded.value;

select cron.schedule('veille-alerts','*/15 * * * *', $cron$
 select net.http_post(
  url := (select value from public.app_config where key='function_url'),
  headers := jsonb_build_object('Content-Type','application/json',
   'x-cron-secret',(select value from public.app_config where key='cron_secret')),
  body := '{"action":"run"}'::jsonb
 );
$cron$);
```

The backend verifies `x-cron-secret` using the restricted `cron_secret_ok` RPC. This scheduled
request is not exercised by the offline tests. Check cron run history and function logs after deployment.
See [Supabase scheduling documentation](https://supabase.com/docs/guides/functions/schedule-functions).

## Verification

`npm test` creates an isolated database, applies the schema, checks RLS/grants, tests invite
limits and next-run scheduling across DST, and checks application-date preservation and deletion
cascades. No hosted database, cron job, or Gmail account is used by this test suite.
