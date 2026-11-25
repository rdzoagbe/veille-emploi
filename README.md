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

## Tests
`node` for the pure functions in `core.js`; Playwright (Pixel 7 profile) for the app, with the Supabase function mocked.
