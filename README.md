# Veille Emploi

Free job-alert app for family and friends: pick the jobs and places you want, get matching offers by email, and keep a history of your applications (with a PDF/CSV export to show your job search).

**App:** https://rdzoagbe.github.io/veille-emploi/ (sign-up by invite link). The old address under the portfolio redirects here.

## How it works
- **Front end** (this folder): a static PWA (`index.html`, `app.js`, `styles.css`, `sw.js`) served by GitHub Pages. French and English.
- **Back end** (`server/veille`): a Supabase Edge Function (Deno) with a Postgres database.
  - Sign-in with a 6-digit code sent by email; sessions last 180 days.
  - Alerts: every 15 minutes `pg_cron` calls the function, which sends the due alerts (startup career boards via public ATS APIs, France Travail when API keys are set, plus search links for LinkedIn, Indeed, WTTJ, HelloWork, APEC).
  - "Mes offres": history of offers received and applications, with statuses, stats and export.
  - Forward-to-add: people forward their application emails to the app mailbox's `+candidatures` address; the function reads them over IMAP, only trusts senders whose address passes DMARC/DKIM/SPF, saves the job / company / status to that person's account and labels the message without deleting it.
- Email goes through the configured Gmail account (SMTP/IMAP with an app password). Only its matching Veille Emploi account may use the optional automatic Gmail label import. For a separately provisioned dedicated mailbox with no matching account, set `VEILLE_DEDICATED_MAILBOX=true` to enable manual forwarding from other accounts; never set this on a personal mailbox.

## Automatic application import (Gmail pilot)

If the notification account differs from the recruitment inbox, configure `IMPORT_GMAIL_USER` and `IMPORT_GMAIL_APP_PASSWORD` together in Supabase Edge Function Secrets. Never replace the existing `GMAIL_USER` / `GMAIL_APP_PASSWORD` notification credentials for this purpose. The import account must exactly match a registered user's sign-in address; that user must explicitly opt in. A partial import configuration disables direct import. Without either import secret, the existing notification mailbox is the fallback. The Gmail app password grants mailbox-level access, not label-scoped access; the worker searches only labelled recruitment emails. Revoke the app password to disconnect at the provider level.

- In Gmail, create `veille-candidatures` and a narrow recruitment-email filter applying that label. The owner must enable the option under My offers. Existing messages may be labelled to import up to 90 days. The scheduled worker checks at most 20 messages per run; it never deletes emails.
- `veille-traite` means handled; `veille-a-verifier` means unclear or not eligible. Remove the latter label to retry after correcting the issue. Transient failures are left eligible for retry. Recruitment alerts and generic messages are not imported. Dates are unknown unless explicitly recorded through the app.
- The Refresh button in My offers checks a fresh batch of labelled messages immediately for the opted-in mailbox owner, then reloads their history and shows added/updated counts. For other accounts it reloads saved history only. A secondary manual entry action remains available. Each manual batch is limited to 20 messages.
- This is not a general mailbox OAuth connection: external accounts cannot use direct label import. Manual forwarding depends on a verified sender and explicit dedicated mailbox configuration. Outlook and arbitrary Gmail accounts need a separate per-user connection design. Do not redirect all mail.

## Secrets (Supabase → Edge Functions → Secrets, never in this repo)
`GMAIL_USER`, `GMAIL_APP_PASSWORD`, optional `FT_CLIENT_ID` / `FT_CLIENT_SECRET` (France Travail API).

## Deploying the function
Deploy `server/veille/index.ts`, `core.js` and `geo.js` together as the `veille` function (`verify_jwt` off). `APP_URL` in `core.js` must match the Pages address.

## Development and tests

Requires Node 22+ (Node 24 used for verification).

```sh
npm ci
npm test
npx playwright install chromium
npm run test:ui
node tests/serve.js
```

Open http://127.0.0.1:4173. Serve over HTTP: the frontend now uses ES modules.
`npm test` runs matching/history regressions and applies both migrations to an isolated
PostgreSQL-compatible PGlite database, including role permissions, RPCs, and date preservation.
Playwright uses a Pixel 7 viewport and mocks the backend; it does not send emails.

Frontend modules: `js/i18n.js` owns translations, `js/exports.js` owns PDF/CSV export,
and `js/history.js` owns export date/CSV helpers. `app.js` wires the UI and account state.

## Matching behavior

- Fully remote requires explicit remote evidence. Hybrid accepts hybrid or fully remote;
  unknown work arrangements are excluded from these restricted modes. On-site accepted allows all.
- Salary filters use the selected range's lower bound, comparing it with the highest advertised
  amount. Open-ended or ambiguous ranges remain eligible. Annual and monthly euro amounts support French separators and k notation; monthly
  amounts are annualized over 12 months. Hourly, net, unknown-period and unsupported-currency
  amounts are not guessed. Missing/unknown salaries remain eligible; the no-salary exclusion
  removes listings without salary text.
- Search links are shortcuts into external boards, not a guarantee that every filter is applied there.

France Travail queries that include a remote location may search nationwide; results are then checked against the selected locations and remote eligibility.

## Application dates

`applied_at` is separate from `sent_at` and `status_at`. Marking a new offer as applied records
that action's time; manual applications use the date entered. Later status changes preserve it.
Forwarding an email cannot establish the original application date, so it remains unknown unless
already recorded. PDF shows unknown dates explicitly; CSV includes separate application/received columns.
Existing manual records are backfilled from their user-entered dates. Other historical dates are not guessed.

## Database setup and upgrade

See [database setup](supabase/README.md) for fresh installations, the additive existing-project
upgrade, invite creation, and cron configuration. Apply the date migration **before** deploying
the new edge function, then publish all frontend files including `js/` and the updated service worker.

## Invitation sharing (administrator-controlled)

Set `INVITE_ADMIN_EMAIL` to the registered administrator's sign-in address in Edge Function secrets before deploying. Only that account receives the active sharing code. Without the secret, no account receives a share link; previously issued invite URLs continue to work until revoked. Rotate the existing shared code in Supabase after rollout if it was distributed more widely than intended. This change does not change existing invite admission rules, add expiry or lifetime limits, or create a management UI. Those require a reviewed live-schema migration; the live invitation schema differs from the fresh-install baseline. Existing approved recipients remain eligible to sign in. Do not use a mailbox credential as an administrator role.
