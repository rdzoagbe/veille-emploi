# Veille Emploi

Free job-alert app for family and friends: pick the jobs and places you want, get matching offers by email, and keep a history of your applications (with a PDF/CSV export to show your job search).

**App:** https://rdzoagbe.github.io/veille-emploi/ (sign-up by invite link). The old address under the portfolio redirects here.

## How it works
- **Front end** (this folder): a static PWA (`index.html`, `app.js`, `styles.css`, `sw.js`) served by GitHub Pages. French and English.
- **Back end** (`server/veille`): a Supabase Edge Function (Deno) with a Postgres database.
  - Sign-in with a 6-digit code sent by email; sessions last 180 days.
  - Alerts: every 15 minutes `pg_cron` calls the function, which sends the due alerts (startup career boards via public ATS APIs, France Travail when API keys are set, plus search links for LinkedIn, Indeed, WTTJ, HelloWork, APEC).
  - "Mes offres": history of offers received and applications, with statuses, stats and export.
  - Forward-to-add: people forward their application emails to the app mailbox's `+candidatures` address; the function reads them over IMAP, only trusts senders whose address passes DMARC/DKIM/SPF, saves the job / company / status to that person's account and deletes the email.
- Email goes through a Gmail account dedicated to the app (SMTP/IMAP with an app password).

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
  amount. Annual and monthly euro amounts support French separators and k notation; monthly
  amounts are annualized over 12 months. Hourly, net, unknown-period and unsupported-currency
  amounts are not guessed. Missing/unknown salaries remain eligible; the no-salary exclusion
  removes listings without salary text.
- Search links are shortcuts into external boards, not a guarantee that every filter is applied there.

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
