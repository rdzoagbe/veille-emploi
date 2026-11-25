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

## Matching policy
- Fully remote requires positive evidence of fully remote work. Hybrid or remote requires evidence of either; on-site accepted allows all workplace modes. Missing workplace metadata does not pass restrictive preferences.
- The selected salary band's lower edge is a minimum target, not a maximum. Explicit comparable EUR annual or monthly amounts below it are rejected; unknown or ambiguous pay remains eligible. The "No salary shown" exclusion rejects listings without salary text. Most startup-board adapters do not supply compensation data today.
- External job-board links are searches, not verified matching offers; their filters and listings must be checked on the destination site.

## Tests
Run the matching regression suite with Node 22:

```sh
node --experimental-default-type=module --test tests/*.test.mjs
```

The suite is offline and does not need credentials. Live email, authenticated flows, database behavior and mobile browser behavior still need separate validation.
