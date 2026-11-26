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
 await expect(page.locator('#mailImportEnabled')).toBeVisible();
 await expect(page.locator('#mailImportEnabled')).not.toBeChecked();
 await expect(page.locator('#mailImportState')).toContainText('Import disabled');
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
 await expect(page.locator('#mailImportEnabled')).toBeChecked();
 await expect(page.locator('#mailImportState')).toContainText('Import enabled');
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
 await expect(page.locator('#mailImportCard')).toBeVisible();
 await expect(page.locator('#mailImportState')).toContainText('Import unavailable for this account');
 await expect(page.locator('#mailImportEnabled')).toBeHidden();
 await expect(page.locator('#refreshOffersMsg')).toContainText('History refreshed only');
 expect(actions).not.toContain('mail_refresh');
});

test('everyone can share the public link; old invite parameters are discarded', async ({page}) => {
 await page.addInitScript(()=>{
  localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['FRANCE'],invite:'oldinvite123',shareInvite:'oldinvite123'}));
  localStorage.setItem('ve:settings',JSON.stringify({lang:'en'}));
 });
 await page.route('**/functions/v1/veille',async route=>{
  const body=route.request().postDataJSON();
  const account={email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['FRANCE']},invite:null};
  return route.fulfill({json:body.action==='offers'?{ok:true,offers:[]}:{ok:true,account}});
 });
 await page.goto('/?i=oldinvite123');
 await expect(page).not.toHaveURL(/oldinvite123/);
 await page.locator('#mobileMenu').click();
 await page.locator('#navSettings').click();
 await expect(page.locator('#inviteShareBox')).toBeVisible();
 await expect(page.locator('#shareWa')).toHaveAttribute('href', /https%3A%2F%2F|http%3A%2F%2F/);
 await expect(page.locator('#shareWa')).not.toHaveAttribute('href', /oldinvite123|%3Fi%3D/);
 expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('ve:data')).invite)).toBeUndefined();
});

test('new visitors can request a login code from the public link without an invite', async ({page})=>{
 const calls=[];
 await page.addInitScript(()=>localStorage.setItem('ve:settings',JSON.stringify({lang:'en'})));
 await page.route('**/functions/v1/veille',async route=>{
  const body=route.request().postDataJSON(); calls.push(body);
  return route.fulfill({json:{ok:true}});
 });
 await page.goto('/');
 await page.locator('#startBtn').click();
 await page.locator('#loginEmail').fill('new@example.org');
 await page.locator('#sendCode').click();
 await expect(page.locator('#codeStep')).toBeVisible();
 expect(calls.find(b=>b.action==='code')).toMatchObject({email:'new@example.org'});
 expect(calls.find(b=>b.action==='code')).not.toHaveProperty('invite');
});

 test('location picker shows one compact field, with selection details only inside the dropdown', async ({page}) => {
 await page.addInitScript(()=>{
  localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['R:IDF']}));
  localStorage.setItem('ve:settings',JSON.stringify({lang:'en'}));
 });
 await page.route('**/functions/v1/veille',async route=>{
  const body=route.request().postDataJSON();
  const account={email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['R:IDF']}};
  return route.fulfill({json:body.action==='offers'?{ok:true,offers:[]}:{ok:true,account}});
 });
 await page.goto('/');
 await page.locator('#navAlerts').click();
 await expect(page.locator('#locTrigger')).toContainText('Île-de-France');
 await expect(page.locator('#locSummary')).toBeHidden();
 await page.locator('#locTrigger').click();
 await expect(page.locator('#locReset')).toBeVisible();
 await expect(page.locator('#locSummary')).toBeHidden();
 await page.locator('#locSearch').fill('Bretagne');
 await page.locator('#locList .opt.whole').click();
 await expect(page.locator('#locSummary')).toBeVisible();
 await expect(page.locator('#locSumRows')).toContainText('Île-de-France');
 await expect(page.locator('#locSumRows')).toContainText('Bretagne');
 await page.locator('#locDone').click();
 await expect(page.locator('#locSummary')).toBeHidden();
 await expect(page.locator('#locTrigger')).toContainText('2 places chosen');
 await page.locator('#locTrigger').click();
 await page.locator('#locReset').click();
 await expect(page.locator('#locTrigger')).toContainText('Choose a region or department');
 await expect(page.locator('#locSummary')).toBeHidden();
 });

test('new workspace uses real account metrics, searches history and navigates to private applications', async({page})=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const now=new Date().toISOString();
 await page.addInitScript(()=>{
  localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',prenom:'Alex',roles:['Engineer'],locations:['R:IDF']}));
  localStorage.setItem('ve:settings',JSON.stringify({lang:'en',theme:'light'}));
 });
 await page.route('**/functions/v1/veille',async route=>{
  const b=route.request().postDataJSON();
  const account={email:'test@example.org',status:'active',prefs:{roles:['Engineer'],locations:['R:IDF'],name:'Alex'},mailImportAvailable:false};
  const offers=[{track_id:'1',title:'Cloud Engineer',company:'Acme',status:'applied',sent_at:now,applied_at:now,source:'forward'},{track_id:'2',title:'Product Designer',company:'Studio',status:'new',sent_at:now,source:'startups'}];
  await route.fulfill({json:b.action==='offers'?{ok:true,offers}:{ok:true,account}});
 });
 await page.goto('/');
 await expect(page.locator('#welcomeTitle')).toContainText('Alex');
 await expect(page.locator('#dashRecv')).toHaveText('2');
 await expect(page.locator('#dashApp')).toHaveText('1');
 await expect(page.locator('#dashImported')).toHaveText('1');
 await expect(page.locator('#dashAlert')).toHaveText('1');
 await page.screenshot({path:'ui-previews/mobile-dashboard.png',fullPage:true});
 await page.locator('#dashQuery').fill('Cloud');
 await page.locator('#dashSearchForm button[type=submit]').click();
 await expect(page.locator('.offer-card')).toHaveCount(1);
 await expect(page.locator('.offer-card')).toContainText('Cloud Engineer');
 await page.locator('.offer-card').click();
 await expect(page.locator('#offerSheet')).toBeVisible();
 await expect(page.locator('#osTitle')).toHaveText('Cloud Engineer');
 await page.screenshot({path:'ui-previews/mobile-offer-detail.png'});
 await page.locator('#osBack').click();
 await page.locator('#navApplications').click();
 await expect(page.locator('.offer-card')).toHaveCount(1);
 await expect(page.locator('#historyTitle')).toHaveText('Applications');
 await page.locator('#navHome').click();
 await expect(page.locator('#dashboardView')).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.setViewportSize({width:1440,height:900});
 await expect(page.locator('#navStats')).toBeVisible();
 await page.screenshot({path:'ui-previews/desktop-dashboard.png',fullPage:true});
 await page.locator('#navStats').click();
 await expect(page.locator('#historyWeeks')).toBeVisible();
 await page.locator('#navMail').click();
 await expect(page.locator('#mailImportCard')).toBeVisible();
 await expect(page.locator('#offerList')).toBeHidden();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 expect(errors).toEqual([]);
});

test('brand logo returns to dashboard on mobile and desktop, or landing when signed out',async({page})=>{
 await page.addInitScript(()=>{localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['R:IDF']}));localStorage.setItem('ve:settings',JSON.stringify({lang:'en',theme:'light'}));});
 await page.route('**/functions/v1/veille',async route=>{const b=route.request().postDataJSON();await route.fulfill({json:b.action==='offers'?{ok:true,offers:[]}:{ok:true,account:{email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['R:IDF']}}}});});
 await page.goto('/');await page.locator('#navOffers').click();await expect(page.locator('#offersView')).toBeVisible();await page.locator('#brandHome').click();await expect(page.locator('#dashboardView')).toBeVisible();await expect(page.locator('#navHome')).toHaveAttribute('aria-current','page');
 await page.setViewportSize({width:1440,height:900});await page.locator('#navAlerts').click();await page.locator('#sidebarHome').click();await expect(page.locator('#dashboardView')).toBeVisible();
 await page.locator('#navSettings').click();await page.locator('#logoutBtn').click();await expect(page.locator('#landing')).toBeVisible();await page.locator('#startBtn').click();await expect(page.locator('#signin')).toBeVisible();await page.locator('#brandHome').click();await expect(page.locator('#landing')).toBeVisible();
});

test('failed account deletion never clears the local session or claims success',async({page})=>{
 await page.addInitScript(()=>{localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['R:IDF']}));localStorage.setItem('ve:settings',JSON.stringify({lang:'en',theme:'light'}));});
 await page.route('**/functions/v1/veille',async route=>{const b=route.request().postDataJSON();if(b.action==='delete')return route.fulfill({status:500,json:{error:'server'}});await route.fulfill({json:b.action==='offers'?{ok:true,offers:[]}:{ok:true,account:{email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['R:IDF']}}}});});
 page.on('dialog',d=>d.accept());
 await page.goto('/');await page.locator('#navAlerts').click();await page.locator('#wipe').click();await expect(page.locator('#banner')).toContainText("Can't reach");await expect(page.locator('#appView')).toBeVisible();expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('ve:data')).session)).toBe('a'.repeat(64));
});
test('sign-out in another tab clears the dashboard in this tab',async({page,context})=>{
 await context.route('**/functions/v1/veille',async route=>{const b=route.request().postDataJSON();await route.fulfill({json:b.action==='offers'?{ok:true,offers:[]}:{ok:true,account:{email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['R:IDF']}}}});});
 await page.goto('/');await page.evaluate(()=>{localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['R:IDF']}));localStorage.setItem('ve:settings',JSON.stringify({lang:'en',theme:'light'}));});await page.reload();await expect(page.locator('#dashboardView')).toBeVisible();
 const other=await context.newPage();await other.goto('/');await expect(other.locator('#dashboardView')).toBeVisible();await other.evaluate(()=>localStorage.removeItem('ve:data'));await expect(page.locator('#landing')).toBeVisible();await expect(page.locator('#dashboardView')).toBeHidden();await other.close();
});

test('selected EML imports require consent, stay scoped to session, and show import results',async({page})=>{
 const calls=[];
 await page.addInitScript(()=>{localStorage.setItem('ve:data',JSON.stringify({session:'a'.repeat(64),email:'test@example.org',roles:['Engineer'],locations:['R:IDF']}));localStorage.setItem('ve:settings',JSON.stringify({lang:'en',theme:'light'}));});
 const account={email:'test@example.org',status:'inactive',prefs:{roles:['Engineer'],locations:['R:IDF']},selectedMailImport:true,outlookClientId:null};
 await page.route('**/functions/v1/veille',async route=>{const b=route.request().postDataJSON();await route.fulfill({json:b.action==='offers'?{ok:true,offers:[]}:{ok:true,account}});});
 await page.route('**/functions/v1/veille?a=mail_file',async route=>{calls.push({session:route.request().headers()['x-veille-session'],type:route.request().headers()['content-type']});await route.fulfill({json:{ok:true,result:'ok'}});});
 await page.goto('/');await page.locator('#navOffers').click();await expect(page.locator('#selectedMailCard')).toBeVisible();
 await expect(page.locator('#outlookConnect')).toBeDisabled();
 await page.locator('#selectedMailInput').setInputFiles({name:'synthetic.eml',mimeType:'message/rfc822',buffer:Buffer.from('Subject: Application confirmation\r\n\r\nTest')});
 await expect(page.locator('#selectedMailImport')).toBeDisabled();
 await page.locator('#selectedMailConsent').check();await expect(page.locator('#selectedMailImport')).toBeEnabled();
 await page.locator('#selectedMailImport').click();await expect(page.locator('#selectedMailResult')).toContainText('1 added');expect(calls).toEqual([{session:'a'.repeat(64),type:'message/rfc822'}]);
 await expect(page.locator('#selectedMailImport')).toBeDisabled();
});
