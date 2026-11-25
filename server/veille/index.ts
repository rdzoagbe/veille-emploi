// Veille Emploi edge function: accounts by email code + email alerts.
//   POST {action:'code', email, invite?, lang?}      -> emails a 6-digit sign-in code (invite-only)
//   POST {action:'verify', email, otp}               -> {session, account}
//   POST {action:'account', session}                 -> {account}
//   POST {action:'save', session, prefs, activate?}  -> saves criteria; activate turns alerts on (first email right away)
//   POST {action:'pause' | 'logout' | 'delete', session}
//   POST {action:'offers', session}                  -> history of offers sent, with opened/status
//   POST {action:'offer_status', session, id, status} -> new | applied | interview | rejected | notforme
//   POST {action:'add_offer', session, title, company?, location?, url?, date?, status?} -> an application found elsewhere
//   POST {action:'delete_offer', session, id}
//   POST {action:'run'} + x-cron-secret header       -> send due alerts and read forwarded emails (pg_cron, every 15 min)
//   Forwarded application emails: people forward them to GMAIL_USER with "+candidatures"; each one is added
//   to the history of the account whose address sent it, and a short confirmation is sent back.
//   GET  ?a=go&o=TRACK_ID (offer links in emails: marks the offer opened, then redirects)
//   GET  ?a=stop&t=TOKEN (link in every email) | ?a=confirm&t=TOKEN (older emails)
import { createClient } from 'npm:@supabase/supabase-js@2.49.4';
import nodemailer from 'npm:nodemailer@6.9.16';
import { ImapFlow } from 'npm:imapflow@1.0.171';
import { simpleParser } from 'npm:mailparser@3.7.2';
import {
  APP_URL, alertEmail, cleanPrefs, codeEmail, fetchFranceTravail, fetchStartups, franceTravailToken, fwdReply, htmlToText, applicationEvent, findApplicationMatch, shouldUpdateApplication, importMailboxConfig, canImportMailbox,
  selectOffers, validEmail,
} from './core.js';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const serviceKey = (() => {
  const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (k) return k;
  try { return JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') || '{}').default; } catch { return ''; }
})();
const db = createClient(SB_URL, serviceKey, { auth: { persistSession: false } });
const FN_URL = `${SB_URL}/functions/v1/veille`;
const GMAIL_USER = (Deno.env.get('GMAIL_USER') || '').trim();
const GMAIL_PASS = (Deno.env.get('GMAIL_APP_PASSWORD') || '').replace(/\s+/g, '');
const IMPORT_MAILBOX = importMailboxConfig(GMAIL_USER, GMAIL_PASS, Deno.env.get('IMPORT_GMAIL_USER'), Deno.env.get('IMPORT_GMAIL_APP_PASSWORD'));
const FWD_ADDR = GMAIL_USER ? GMAIL_USER.replace('@', '+candidatures@') : '';
const FT_ID = Deno.env.get('FT_CLIENT_ID') || '';
const FT_SECRET = Deno.env.get('FT_CLIENT_SECRET') || '';
const CODE_TTL_MS = 10 * 60000;
const MAX_TRIES = 5;
const SESSION_DAYS = 180;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-allow-headers': 'content-type, authorization, apikey, x-client-info',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
const back = (hash: string) => new Response(null, { status: 302, headers: { location: `${APP_URL}#${hash}` } });
const now = () => new Date().toISOString();

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function sixDigits() {
  const a = new Uint32Array(1); crypto.getRandomValues(a);
  return String(a[0] % 1000000).padStart(6, '0');
}
function randomToken() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

let transport: ReturnType<typeof nodemailer.createTransport> | null = null;
async function sendMail(to: string, m: { subject: string; html: string; text: string }) {
  if (!GMAIL_USER || !GMAIL_PASS) throw new Error('Gmail secrets missing');
  transport ??= nodemailer.createTransport({ host: 'smtp.gmail.com', port: 465, secure: true, auth: { user: GMAIL_USER, pass: GMAIL_PASS } });
  await transport.sendMail({ from: `"Veille Emploi" <${GMAIL_USER}>`, to, subject: m.subject, html: m.html, text: m.text });
}

async function nextRun(hour: string, daysAhead: number) {
  const from = new Date(Date.now() + Math.max(0, daysAhead) * 86400000).toISOString();
  const { data, error } = await db.rpc('next_run', { hhmm: hour, from_ts: from });
  if (error) throw error;
  return data as string;
}

/* ---------- sending one alert ---------- */
type Sub = { id: string; email: string; token: string; status: string; prefs: Record<string, unknown>; next_run_at: string | null; last_sent_at?: string | null };
let startupCache: Promise<{ jobs: unknown[]; errors: string[] }> | null = null;
let ftToken: Promise<string> | null = null;

async function sendAlert(sub: Sub, first = false) {
  const prefs = cleanPrefs(sub.prefs);
  const sources = prefs.sources;
  const jobs: unknown[] = [];
  const errors: string[] = [];
  if (sources.includes('startups')) {
    startupCache ??= fetchStartups();
    const r = await startupCache; jobs.push(...r.jobs); errors.push(...r.errors);
  }
  const ftOn = !!(FT_ID && FT_SECRET);
  if (sources.includes('francetravail') && ftOn) {
    try { ftToken ??= franceTravailToken(FT_ID, FT_SECRET); jobs.push(...await fetchFranceTravail(await ftToken, prefs)); }
    catch (e) { errors.push('francetravail: ' + (e as Error).message); ftToken = null; }
  }
  const { data: seenRows } = await db.from('sent_offers').select('offer_key').eq('sub_id', sub.id)
    .gte('sent_at', new Date(Date.now() - 90 * 86400000).toISOString());
  const seen = new Set((seenRows || []).map((r) => r.offer_key));
  const offers = selectOffers(jobs, prefs, seen);
  const next = await nextRun(prefs.hour, Number(prefs.freq) - 1);
  // Keep each offer in the history; email links go through ?a=go so opened offers are counted.
  let tracked = offers;
  const keys = offers.map((o: { key: string }) => o.key);
  if (offers.length) {
    const rows = offers.map((o: Record<string, string>) => ({
      sub_id: sub.id, offer_key: o.key, title: String(o.title).slice(0, 200), company: (o.company || '').slice(0, 120),
      location: (o.location || '').slice(0, 200), url: o.url, source: o.source, posted_at: o.posted || null,
    }));
    const { data: ins, error: insErr } = await db.from('offers').upsert(rows, { onConflict: 'sub_id,offer_key' }).select('offer_key,track_id');
    if (insErr) console.error('offers insert', insErr.message);
    const byKey = new Map((ins || []).map((r) => [r.offer_key, r.track_id]));
    tracked = offers.map((o: { key: string }) => (byKey.has(o.key) ? { ...o, url: `${FN_URL}?a=go&o=${byKey.get(o.key)}` } : o));
  }
  const mail = alertEmail(prefs, tracked, { stopUrl: `${FN_URL}?a=stop&t=${sub.token}`, nextRun: next, first, ftLink: sources.includes('francetravail') && !ftOn });
  let err: string | null = null;
  try { await sendMail(sub.email, mail); } catch (e) { err = (e as Error).message; }
  if (err && keys.length) await db.from('offers').delete().eq('sub_id', sub.id).in('offer_key', keys).is('opened_at', null);
  if (!err && offers.length) {
    await db.from('sent_offers').upsert(offers.flatMap((o: { id: string; key: string }) => [{ sub_id: sub.id, offer_key: o.id }, { sub_id: sub.id, offer_key: o.key }]), { onConflict: 'sub_id,offer_key', ignoreDuplicates: true });
  }
  await db.from('send_log').insert({ sub_id: sub.id, kind: 'alert', offers: offers.length, error: err || (errors.length ? errors.join('; ').slice(0, 900) : null) });
  await db.from('subscriptions').update({
    next_run_at: err ? new Date(Date.now() + 3600000).toISOString() : next,
    last_sent_at: err ? undefined : now(), last_error: err, updated_at: now(),
  }).eq('id', sub.id);
  return { offers: offers.length, error: err, sourceErrors: errors };
}

/* ---------- forwarded application emails ---------- */
const ST_LABEL: Record<string, Record<string, string>> = {
  fr: { applied: 'Postulé', interview: 'Entretien', rejected: 'Refusé' }, en: { applied: 'Applied', interview: 'Interview', rejected: 'Rejected' },
};
type ImportAccount = { id: string; email: string; prefs: Record<string, unknown> };
type ImportMail = { subject?: string; text?: string; html?: string | false; date?: Date; messageId?: string; from?: { value?: { address?: string; name?: string }[] } };
async function handleApplicationMail(sub: ImportAccount, mail: ImportMail, direct = false) {
  const sender = mail.from?.value?.[0];
  const input = { subject: mail.subject || '', fromName: direct ? sender?.name || '' : '', fromAddress: direct ? sender?.address || '' : '' };
  const p = applicationEvent({ ...input, text: mail.html ? htmlToText(mail.html) : mail.text || '' })
    || (mail.html && mail.text ? applicationEvent({ ...input, text: mail.text }) : null);
  if (!p) return { result: 'review' };
  // A confirmation is not necessarily the date the candidate actually applied.
  const stamp = mail.date?.getTime();
  const when = new Date(stamp && Number.isFinite(stamp) && stamp <= Date.now() ? stamp : Date.now()).toISOString();
  const { data: rows, error: readError } = await db.from('offers').select('id,title,company,status,status_at,url').eq('sub_id', sub.id);
  if (readError) throw readError;
  const match = findApplicationMatch(rows || [], p);
  if (match.ambiguous) return { result: 'review' };
  let kind = 'ok'; let title = p.title; let company = p.company; let status = p.status;
  if (match.row) {
    const same = match.row;
    title = same.title; company = same.company || company;
    if (shouldUpdateApplication(same, p.status, when)) {
      // Compare-and-set prevents an older concurrent event overwriting a newer status.
      let update = db.from('offers').update({ status: p.status, status_at: when }).eq('id', same.id).eq('sub_id', sub.id).eq('status', same.status);
      update = same.status_at ? update.eq('status_at', same.status_at) : update.is('status_at', null);
      const { data: updated, error } = await update.select('id');
      if (error) throw error;
      if (!updated?.length) throw new Error('application changed concurrently; retry');
      kind = 'upd';
    } else { kind = 'dup'; status = same.status; }
  } else {
    // Stable identity also prevents two concurrent cron workers creating duplicate rows.
    // Deliberately do not use the unsubscribe token or mailbox credentials.
    const identity = p.url || (p.company.normalize('NFKC').toLowerCase().trim() + '|' + p.title.normalize('NFKC').toLowerCase().trim());
    const key = 'mail:' + (await sha256(identity)).slice(0, 40);
    const { data: ins, error } = await db.from('offers').upsert({
      sub_id: sub.id, offer_key: key, title, company, url: p.url, source: 'forward', sent_at: when, opened_at: when, status, status_at: when,
    }, { onConflict: 'sub_id,offer_key', ignoreDuplicates: true }).select('id');
    if (error) throw error;
    if (!ins?.length) throw new Error('application inserted concurrently; retry');
  }
  // Avoid automatic reply loops for labelled mail and for duplicates.
  const lang = sub.prefs?.lang === 'en' ? 'en' : 'fr';
  if (!direct && kind !== 'dup') await sendMail(sub.email, fwdReply(lang, kind, { title, company, statusLabel: ST_LABEL[lang][status] || status })).catch(() => {});
  await db.from('send_log').insert({ sub_id: sub.id, kind: 'forward', error: kind });
  return { result: kind };
}
// Only the receiving Gmail server's first Authentication-Results header is considered.
function senderVerified(from: string, auth: unknown) {
  const dom = from.split('@')[1]?.toLowerCase();
  const header = Array.isArray(auth) ? String(auth[0] || '') : String(auth || '');
  if (!dom || !/^\s*mx\.google\.com\s*;/i.test(header)) return false;
  const clauses = header.split(';');
  return clauses.some(c => {
    if (!/^\s*dmarc=pass\b/i.test(c)) return false;
    const d = c.match(/\bheader\.from=([^\s;]+)/i)?.[1]?.toLowerCase();
    return d === dom;
  });
}
async function mailboxOwner(user = GMAIL_USER) {
  if (!user) return null;
  const { data, error } = await db.from('subscriptions').select('id,email,prefs').eq('email', user.toLowerCase()).maybeSingle();
  if (error) throw error;
  return data as ImportAccount | null;
}
async function fwdAddressFor(email: unknown) {
  if (!FWD_ADDR) return '';
  const owner = await mailboxOwner();
  // Fail closed: a shared inbox must be explicitly provisioned as dedicated.
  return owner ? (String(email || '').toLowerCase() === owner.email ? FWD_ADDR : '') : (Deno.env.get('VEILLE_DEDICATED_MAILBOX') === 'true' ? FWD_ADDR : '');
}
async function processForwards(onlyOwnerId?: string, directMode = false) {
  const config = directMode ? IMPORT_MAILBOX : (GMAIL_USER && GMAIL_PASS ? { user: GMAIL_USER, pass: GMAIL_PASS } : null);
  if (!config) { if (onlyOwnerId) throw new Error('mailbox unavailable'); return []; }
  const owner = await mailboxOwner(config.user);
  if (onlyOwnerId && (owner?.id !== onlyOwnerId || owner?.prefs?.mailImport !== true)) throw new Error('import unavailable');
  const dedicated = !directMode && !owner && Deno.env.get('VEILLE_DEDICATED_MAILBOX') === 'true';
  const directOn = directMode && owner?.prefs?.mailImport === true;
  if (directMode ? !directOn : (!owner && !dedicated)) return [];
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user: config.user, pass: config.pass }, logger: false });
  const out: { result: string }[] = [];
  await client.connect();
  try {
    const boxes = await client.list();
    const allMail = boxes.find((b: { specialUse?: string; path: string }) => b.specialUse === '\\All')?.path || '[Gmail]/All Mail';
    const lock = await client.getMailboxLock(allMail);
    try {
      const exclude = '-label:veille-traite -label:veille-a-verifier';
      const forwarded = directMode ? [] : ((await client.search({ gmraw: 'to:' + FWD_ADDR + ' ' + exclude + ' newer_than:30d' }, { uid: true })) || []);
      const labelled = directOn ? (await client.search({ gmraw: 'label:veille-candidatures ' + exclude + ' newer_than:90d' + (FWD_ADDR && config.user.toLowerCase() === GMAIL_USER.toLowerCase() ? ' -to:' + FWD_ADDR : '') }, { uid: true })) || [] : [];
      const directIds = new Set(labelled);
      const uids = [...new Set([...forwarded, ...labelled])].slice(0, 20);
      for (const uid of uids) {
        try {
          const msg = await client.fetchOne(String(uid), { source: true, size: true }, { uid: true });
          if (!msg?.source) throw new Error('message unavailable');
          if (msg.source.length > 2_000_000) {
            await client.messageFlagsAdd(String(uid), ['veille-a-verifier'], { uid: true, useLabels: true });
            out.push({ result: 'review' });
            continue;
          }
          const mail = await simpleParser(msg.source);
          const from = (mail.from?.value?.[0]?.address || '').toLowerCase();
          let sub: ImportAccount | null = null;
          const direct = directIds.has(uid) && !!owner && directOn && !forwarded.includes(uid);
          if (direct) sub = owner;
          else if (!directMode && from && senderVerified(from, mail.headers.get('authentication-results'))) {
            if (owner) sub = from === owner.email ? owner : null;
            else {
              const { data, error } = await db.from('subscriptions').select('id,email,prefs').eq('email', from).maybeSingle();
              if (error) throw error;
              sub = data as ImportAccount | null;
            }
          }
          const result = sub ? await handleApplicationMail(sub, mail, direct) : { result: 'review' };
          await client.messageFlagsAdd(String(uid), [result.result === 'review' ? 'veille-a-verifier' : 'veille-traite'], { uid: true, useLabels: true });
          out.push({ result: result.result });
        } catch {
          // Keep the message and leave it eligible for retry. Never delete on a failed write.
          out.push({ result: 'retry' });
        }
      }
    } finally { lock.release(); }
  } finally { await client.logout().catch(() => {}); }
  return out;
}

// Coalesce rapid manual refreshes within an isolate; database compare-and-set and
// stable offer identities still protect against concurrent cron/import workers.
let ownerRefresh: Promise<{ result: string }[]> | null = null;
let lastOwnerRefresh = 0;
async function refreshApplications(ownerId: string) {
  if (ownerRefresh) return ownerRefresh;
  if (Date.now() - lastOwnerRefresh < 15000) return null;
  lastOwnerRefresh = Date.now();
  ownerRefresh = processForwards(ownerId, true);
  try { return await ownerRefresh; } finally { ownerRefresh = null; }
}

async function runDue() {
  const { data: due, error } = await db.from('subscriptions').select('id,email,token,status,prefs,next_run_at')
    .eq('status', 'active').lte('next_run_at', now()).order('next_run_at').limit(25);
  if (error) throw error;
  const results = [];
  for (const s of due || []) results.push({ id: s.id, ...(await sendAlert(s as Sub)) });
  return results;
}

/* ---------- accounts ---------- */
async function inviteCode() {
  const { data } = await db.from('invite_codes').select('code').eq('active', true).order('created_at').limit(1).maybeSingle();
  return data?.code || null;
}
async function accountView(sub: Record<string, unknown>) {
  const p = (sub.prefs && Object.keys(sub.prefs as object).length) ? sub.prefs : (sub.pending_prefs || {});
  return {
    email: sub.email, status: sub.status === 'pending' ? 'inactive' : sub.status, prefs: p,
    next_run_at: sub.status === 'active' ? sub.next_run_at : null, last_sent_at: sub.last_sent_at, invite: await inviteCode(), fwd: await fwdAddressFor(sub.email), mailImportAvailable: canImportMailbox(sub.email, IMPORT_MAILBOX), mailImport: (p as Record<string, unknown>).mailImport === true,
  };
}
async function bySession(token: unknown) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null;
  const hash = await sha256(token);
  const { data: s } = await db.from('sessions').select('sub_id,created_at').eq('token_hash', hash).maybeSingle();
  if (!s || Date.now() - Date.parse(s.created_at) > SESSION_DAYS * 86400000) return null;
  await db.from('sessions').update({ last_seen: now() }).eq('token_hash', hash);
  const { data: sub } = await db.from('subscriptions').select('*').eq('id', s.sub_id).maybeSingle();
  return sub ? { sub, hash } : null;
}

async function requestCode(body: Record<string, unknown>) {
  const email = String(body.email || '').trim().toLowerCase();
  if (!validEmail(email)) return json({ error: 'bad_email' }, 400);
  const { data: inv } = await db.from('invites').select('email').eq('email', email).maybeSingle();
  if (!inv) {
    const code = typeof body.invite === 'string' ? body.invite.trim().toLowerCase().slice(0, 32) : '';
    const { data: ok } = code ? await db.rpc('claim_invite', { p_email: email, p_code: code }) : { data: false };
    if (!ok) return json({ error: 'not_invited' }, 403);
  }
  const { data: recent } = await db.from('login_codes').select('created_at').eq('email', email)
    .gte('created_at', new Date(Date.now() - 3600000).toISOString()).order('created_at', { ascending: false });
  if (recent?.length && Date.now() - Date.parse(recent[0].created_at) < 45000) return json({ error: 'wait', seconds: 45 }, 429);
  if ((recent?.length || 0) >= 6) return json({ error: 'too_many' }, 429);
  const otp = sixDigits();
  await db.from('login_codes').insert({ email, code_hash: await sha256(`${email}:${otp}`), expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString() });
  try { await sendMail(email, codeEmail(body.lang === 'en' ? 'en' : 'fr', otp)); }
  catch (e) { console.error('code mail', (e as Error).message); return json({ error: 'mail_failed' }, 502); }
  return json({ ok: true });
}

async function verifyCode(body: Record<string, unknown>) {
  const email = String(body.email || '').trim().toLowerCase();
  const otp = String(body.otp || '').replace(/\D/g, '');
  if (!validEmail(email) || otp.length !== 6) return json({ error: 'bad_code' }, 400);
  const { data: row } = await db.from('login_codes').select('*').eq('email', email).order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!row || Date.parse(row.expires_at) < Date.now()) return json({ error: 'expired' }, 400);
  if (row.attempts >= MAX_TRIES) return json({ error: 'locked' }, 429);
  if (row.code_hash !== await sha256(`${email}:${otp}`)) {
    await db.from('login_codes').update({ attempts: row.attempts + 1 }).eq('id', row.id);
    const left = MAX_TRIES - row.attempts - 1;
    return json({ error: left > 0 ? 'bad_code' : 'locked', left }, left > 0 ? 400 : 429);
  }
  await db.from('login_codes').delete().eq('email', email);
  let { data: sub } = await db.from('subscriptions').select('*').eq('email', email).maybeSingle();
  if (!sub) {
    const { data, error } = await db.from('subscriptions').insert({ email, status: 'inactive', confirmed_at: now() }).select('*').single();
    if (error) throw error; sub = data;
  } else if (sub.status === 'pending') {
    const { data } = await db.from('subscriptions').update({ status: 'inactive', confirmed_at: now(), updated_at: now() }).eq('id', sub.id).select('*').single();
    sub = data;
  }
  const session = randomToken();
  await db.from('sessions').insert({ token_hash: await sha256(session), sub_id: sub.id });
  return json({ ok: true, session, account: await accountView(sub) });
}

async function save(sub: Record<string, unknown>, body: Record<string, unknown>) {
  const prefs = cleanPrefs((body.prefs || {}) as Record<string, unknown>);
  const activate = body.activate === true;
  if (activate && (!prefs.roles.length || !prefs.locations.length || !prefs.sources.length)) return json({ error: 'missing_fields' }, 400);
  const wasActive = sub.status === 'active';
  const turnOn = activate && !wasActive;
  const old = cleanPrefs((sub.prefs || {}) as Record<string, unknown>);
  prefs.mailImport = old.mailImport; // Only the explicit authenticated opt-in action changes this.
  let next = sub.next_run_at as string | null;
  if (turnOn) next = await nextRun(prefs.hour, Number(prefs.freq) - 1);
  else if (wasActive && (old.hour !== prefs.hour || old.freq !== prefs.freq)) next = await nextRun(prefs.hour, 0);
  const status = activate || wasActive ? 'active' : (sub.status === 'paused' ? 'paused' : 'inactive');
  const { data: updated } = await db.from('subscriptions').update({ prefs, pending_prefs: null, status, next_run_at: next, updated_at: now() })
    .eq('id', sub.id as string).select('*').single();
  if (turnOn) {
    // First email right away: it confirms the alerts are on and brings today's offers.
    // @ts-ignore EdgeRuntime exists on Supabase
    EdgeRuntime.waitUntil(sendAlert(updated as Sub, true).catch((e) => console.error('first alert', e)));
  }
  return json({ ok: true, activated: turnOn, account: await accountView(updated) });
}

async function byToken(t: string | null) {
  if (!t || !/^[0-9a-f-]{36}$/i.test(t)) return null;
  const { data } = await db.from('subscriptions').select('*').eq('token', t).maybeSingle();
  return data;
}

Deno.serve(async (req) => {
  try {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
    const url = new URL(req.url);
    if (req.method === 'GET') {
      const a = url.searchParams.get('a'); const t = url.searchParams.get('t');
      if (a === 'go') {
        const o = url.searchParams.get('o');
        const { data: off } = o && /^[0-9a-f-]{36}$/i.test(o)
          ? await db.from('offers').select('id,url,opened_at').eq('track_id', o).maybeSingle() : { data: null };
        if (!off || !/^https:\/\//i.test(off.url || '')) return new Response(null, { status: 302, headers: { location: APP_URL } });
        if (!off.opened_at) await db.from('offers').update({ opened_at: now() }).eq('id', off.id);
        return new Response(null, { status: 302, headers: { location: off.url, 'cache-control': 'no-store' } });
      }
      if (a === 'stop' || a === 'confirm') {
        const sub = await byToken(t);
        if (!sub) return back('ve=invalid');
        if (a === 'stop') {
          await db.from('subscriptions').update({ status: 'paused', updated_at: now() }).eq('id', sub.id);
          return back('ve=stopped');
        }
        return back('ve=signin');
      }
      return json({ ok: true, service: 'veille' });
    }
    if (req.method !== 'POST') return json({ error: 'method' }, 405);
    const body = await req.json().catch(() => ({}));
    switch (body.action) {
      case 'code': return await requestCode(body);
      case 'verify': return await verifyCode(body);
      case 'mail_refresh': case 'mail_import': case 'account': case 'save': case 'pause': case 'logout': case 'delete': case 'offers': case 'offer_status': case 'add_offer': case 'delete_offer': {
        const s = await bySession(body.session);
        if (!s) return json({ error: 'signed_out' }, 401);
        if (body.action === 'account') return json({ ok: true, account: await accountView(s.sub) });
        if (body.action === 'mail_refresh') {
          if (!canImportMailbox(s.sub.email, IMPORT_MAILBOX) || s.sub.prefs?.mailImport !== true) return json({ error: 'not_available' }, 403);
          try {
            const result = await refreshApplications(s.sub.id);
            if (!result) return json({ error: 'refresh_wait' }, 429);
            const count = (kind: string) => result.filter(r => r.result === kind).length;
            return json({ ok: true, added: count('ok'), updated: count('upd'), review: count('review'), retry: count('retry'), checked: result.length, batchLimit: result.length >= 20 });
          } catch { return json({ error: 'mail_refresh_failed' }, 503); }
        }
        if (body.action === 'mail_import') {
          if (!canImportMailbox(s.sub.email, IMPORT_MAILBOX)) return json({ error: 'not_available' }, 403);
          if (typeof body.enabled !== 'boolean') return json({ error: 'bad_request' }, 400);
          const prefs = { ...(s.sub.prefs || {}), mailImport: body.enabled };
          const { data, error } = await db.from('subscriptions').update({ prefs, updated_at: now() }).eq('id', s.sub.id).select('*').single();
          if (error) throw error;
          return json({ ok: true, account: await accountView(data) });
        }
        if (body.action === 'save') return await save(s.sub, body);
        if (body.action === 'offers') {
          const { data, error } = await db.from('offers').select('track_id,title,company,location,url,source,posted_at,sent_at,opened_at,status,applied_at')
            .eq('sub_id', s.sub.id).gte('sent_at', new Date(Date.now() - 365 * 86400000).toISOString()).order('sent_at', { ascending: false }).limit(500);
          if (error) throw error;
          return json({ ok: true, offers: data || [] });
        }
        if (body.action === 'add_offer') {
          const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
          const title = clip(body.title, 200); const company = clip(body.company, 120);
          const url = clip(body.url, 1000); const location = clip(body.location, 200);
          const st = ['new', 'applied', 'interview', 'rejected', 'notforme'].includes(String(body.status)) ? String(body.status) : 'applied';
          if (!title) return json({ error: 'missing_title' }, 400);
          if (url && !/^https?:\/\/[^\s]+$/i.test(url)) return json({ error: 'bad_url' }, 400);
          const d = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? new Date(body.date + 'T12:00:00Z') : new Date();
          const when = isNaN(d.getTime()) || d.getTime() > Date.now() + 86400000 ? now() : d.toISOString();
          const { count } = await db.from('offers').select('id', { count: 'exact', head: true }).eq('sub_id', s.sub.id).eq('source', 'manual')
            .gte('sent_at', new Date(Date.now() - 86400000).toISOString());
          if ((count || 0) >= 100) return json({ error: 'too_many' }, 429);
          const { data, error } = await db.from('offers').insert({
            sub_id: s.sub.id, offer_key: 'manual:' + crypto.randomUUID(), title, company, location, url: url ? (url.startsWith('http://') ? url.replace('http://', 'https://') : url) : null,
            source: 'manual', sent_at: when, opened_at: when, status: st, status_at: now(), applied_at: ['applied', 'interview', 'rejected'].includes(st) ? when : null,
          }).select('track_id,title,company,location,url,source,posted_at,sent_at,opened_at,status,applied_at').single();
          if (error) throw error;
          return json({ ok: true, offer: data });
        }
        if (body.action === 'delete_offer') {
          if (typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) return json({ error: 'bad_request' }, 400);
          await db.from('offers').delete().eq('track_id', body.id).eq('sub_id', s.sub.id);
          return json({ ok: true });
        }
        if (body.action === 'offer_status') {
          const st = String(body.status || '');
          if (!['new', 'applied', 'interview', 'rejected', 'notforme'].includes(st) || typeof body.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(body.id)) return json({ error: 'bad_request' }, 400);
          const { data: cur } = await db.from('offers').select('id,opened_at,status,applied_at').eq('track_id', body.id).eq('sub_id', s.sub.id).maybeSingle();
          if (!cur) return json({ error: 'not_found' }, 404);
          const updated = await db.from('offers').update({ status: st, status_at: now(), applied_at: cur.applied_at || (st === 'applied' && ['new', 'notforme'].includes(cur.status) ? now() : null), opened_at: cur.opened_at || (st !== 'new' ? now() : null) }).eq('id', cur.id).select('applied_at').single();
          if (updated.error) throw updated.error;
          return json({ ok: true, applied_at: updated.data.applied_at });
        }
        if (body.action === 'pause') {
          const { data } = await db.from('subscriptions').update({ status: 'paused', updated_at: now() }).eq('id', s.sub.id).select('*').single();
          return json({ ok: true, account: await accountView(data) });
        }
        if (body.action === 'logout') { await db.from('sessions').delete().eq('token_hash', s.hash); return json({ ok: true }); }
        await db.from('subscriptions').delete().eq('id', s.sub.id); // sessions, sent offers and logs go with it
        return json({ ok: true, deleted: true });
      }
      case 'run': {
        const { data: ok } = await db.rpc('cron_secret_ok', { s: req.headers.get('x-cron-secret') || '' });
        if (!ok) return json({ error: 'forbidden' }, 403);
        const both = async () => {
          const fwd = await processForwards().catch(() => [{ result: 'forward_failed' }]);
          const direct = await processForwards(undefined, true).catch(() => [{ result: 'import_failed' }]);
          const results = await runDue();
          return { fwd, direct, results };
        };
        if (body.wait) { const r = await both(); return json({ ok: true, sent: r.results.length, ...r }); }
        // @ts-ignore EdgeRuntime exists on Supabase
        EdgeRuntime.waitUntil(both().then((r) => console.log('run', JSON.stringify(r))).catch((e) => console.error('run', e)));
        return json({ ok: true, started: true }, 202);
      }
      default: return json({ error: 'unknown_action' }, 400);
    }
  } catch (e) {
    console.error(e);
    return json({ error: 'server', message: (e as Error).message }, 500);
  }
});
