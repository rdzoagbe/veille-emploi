import { readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
test('mobile modules load and exports use application date, including unknown dates',async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const now=new Date().toISOString();
 await page.addInitScript(()=>{
  localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['FRANCE']}));
  localStorage.setItem('ve:settings',JSON.stringify({lang:'en'}));window.print=()=>{};
 });
 await page.route('**/functions/v1/veille',async route=>{
  const b=route.request().postDataJSON();
  const account={email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['FRANCE'],remote:'remote'}};
  const offers=[{track_id:'1',title:'Known date',company:'Example',status:'applied',sent_at:now,applied_at:'2026-01-02T12:00:00Z'}, {track_id:'2',title:'Unknown date',company:'Example',status:'applied',sent_at:now,applied_at:null}];
  await route.fulfill({json:b.action==='offers'?{ok:true,offers}:{ok:true,account}});
 });
 await page.goto('/');await expect(page.locator('#navOffers')).toBeVisible();
 await page.locator('#navOffers').click();await expect(page.locator('.offer-card')).toHaveCount(2);
 await page.locator('#exportBtn').click();await page.locator('#exportPdf').click();
 await expect(page.locator('#printArea')).toContainText('02/01/2026');
 await expect(page.locator('#printArea')).toContainText('Unknown');
 await expect(page.locator('#printArea')).toContainText('Application date');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.locator('#exportBtn').click();
 const downloadPromise=page.waitForEvent('download');
 await page.locator('#exportCsv').click();
 const download=await downloadPromise;const csv=await readFile(await download.path(),'utf8');
 expect(csv).toContain('Application date');expect(csv).toContain('Offer received');
 expect(csv).toContain('02/01/2026');
 expect(csv.split('\r\n').find(line=>line.includes('Unknown date'))).toMatch(/^"";/);
 expect(errors).toEqual([]);
});

test('automatic mail import is opt-in and saved through the authenticated endpoint', async ({page})=>{
 let enabled=false;
 await page.addInitScript(()=>{
  localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['FRANCE']}));
  localStorage.setItem('ve:settings',JSON.stringify({lang:'en'}));
 });
 await page.route('**/functions/v1/veille',async route=>{
  const b=route.request().postDataJSON();
  if(b.action==='mail_import') enabled=b.enabled===true;
  const account={email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['FRANCE']},fwd:'test+candidatures@example.org',mailImportAvailable:true,mailImport:enabled};
  await route.fulfill({json:b.action==='offers'?{ok:true,offers:[]}:{ok:true,account}});
 });
 await page.goto('/');
 await page.locator('#navOffers').click();
 await page.locator('#fwdCard summary').click();
 await expect(page.locator('#mailImportEnabled')).toBeVisible();
 await expect(page.locator('#mailImportEnabled')).not.toBeChecked();
 await page.locator('#mailImportEnabled').check();
 await expect(page.locator('#mailImportMsg')).toHaveText('Preference saved.');
 expect(enabled).toBe(true);
 await page.locator('#mailImportEnabled').uncheck();
 await expect(page.locator('#mailImportMsg')).toHaveText('Preference saved.');
 expect(enabled).toBe(false);
});

test('refresh syncs opted-in mailbox before fetching updated applications', async ({page}) => {
 const actions=[]; let refreshed=false;
 await page.addInitScript(()=>{
  localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['FRANCE']}));
  localStorage.setItem('ve:settings',JSON.stringify({lang:'en'}));
 });
 await page.route('**/functions/v1/veille',async route=>{
  const b=route.request().postDataJSON(); actions.push(b.action);
  const account={email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['FRANCE']},fwd:'test+candidatures@example.org',mailImportAvailable:true,mailImport:true};
  if(b.action==='mail_refresh') { refreshed=true; return route.fulfill({json:{ok:true,added:1,updated:0,review:1,retry:0,checked:2}}); }
  const offers=refreshed?[{track_id:'3',title:'Synced Engineer',company:'Example',status:'applied',sent_at:new Date().toISOString(),applied_at:null}]:[];
  return route.fulfill({json:b.action==='offers'?{ok:true,offers}:{ok:true,account}});
 });
 await page.goto('/');
 await page.locator('#navOffers').click();
 await page.locator('#fwdCard summary').click();
 await expect(page.locator('#mailImportEnabled')).toBeChecked();
 await page.locator('#refreshOffersBtn').click();
 await expect(page.locator('#refreshOffersMsg')).toContainText('1 added, 0 updated');
 await expect(page.locator('#refreshOffersMsg')).toContainText('1 email(s) to review');
 await expect(page.locator('.offer-card')).toContainText('Synced Engineer');
 const i=actions.indexOf('mail_refresh'); expect(i).toBeGreaterThan(-1); expect(actions.slice(i+1)).toContain('offers');
 await expect(page.locator('#addOfferBtn')).toHaveText('Manual entry');
});
test('refresh without enabled mail import only reloads saved history', async ({page}) => {
 const actions=[];
 await page.addInitScript(()=>{
  localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['FRANCE']}));
  localStorage.setItem('ve:settings',JSON.stringify({lang:'en'}));
 });
 await page.route('**/functions/v1/veille',async route=>{
  const b=route.request().postDataJSON(); actions.push(b.action);
  const account={email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['FRANCE']},mailImportAvailable:false,mailImport:false};
  return route.fulfill({json:b.action==='offers'?{ok:true,offers:[]}:{ok:true,account}});
 });
 await page.goto('/');
 await page.locator('#navOffers').click();
 await page.locator('#refreshOffersBtn').click();
 await expect(page.locator('#refreshOffersMsg')).toContainText('History refreshed');
 expect(actions).not.toContain('mail_refresh');
});
