import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
test('fresh schema, private access, RPCs and date lifecycle', async () => {
 const db=new PGlite();
 try {
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 for(const file of (await readdir('supabase/migrations')).sort()) await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 const query=async(sql,params=[]) => (await db.query(sql,params)).rows;
 assert.equal((await query("select count(*)::int as n from pg_tables where schemaname='public' and rowsecurity"))[0].n,9);
 assert.equal((await query("select has_table_privilege('anon','public.offers','select') as allowed"))[0].allowed,false);
 assert.equal((await query("select has_function_privilege('anon','public.claim_invite(text,text)','execute') as allowed"))[0].allowed,false);
 await db.exec("set role anon");
 await assert.rejects(db.query('select * from public.offers'),/permission denied/);
 await db.exec('reset role; set role service_role');
 await db.exec("insert into public.invite_codes(code,max_uses) values('test',1)");
 assert.equal((await query("select claim_invite('a@example.org','test') as ok"))[0].ok,true);
 assert.equal((await query("select claim_invite('a@example.org','test') as ok"))[0].ok,true);
 assert.equal((await query("select claim_invite('b@example.org','test') as ok"))[0].ok,false);
 assert.equal((await query("select cron_secret_ok('') as ok"))[0].ok,false);
 await db.exec("insert into public.app_config values('cron_secret','test-only')");
 assert.equal((await query("select cron_secret_ok('test-only') as ok"))[0].ok,true);
 const next=(await query("select next_run('07:45','2026-03-28T08:00:00Z') as n"))[0].n;
 assert.equal(new Date(next).toISOString(),'2026-03-29T05:45:00.000Z');
 const id=(await query("insert into public.subscriptions(email) values('a@example.org') returning id"))[0].id;
 const offer=(await query("insert into public.offers(sub_id,offer_key,title,source) values($1,'a','Engineer','startups') returning id,applied_at",[id]))[0];
 assert.equal(offer.applied_at,null);
 const applied=(await query("update public.offers set status='applied', applied_at=now() where id=$1 returning applied_at",[offer.id]))[0].applied_at;
 assert.ok(applied);
 const later=(await query("update public.offers set status='interview', applied_at=now()+interval '1 day' where id=$1 returning applied_at",[offer.id]))[0].applied_at;
 assert.equal(new Date(later).getTime(),new Date(applied).getTime());
 const forwarded=(await query("insert into public.offers(sub_id,offer_key,title,source,status) values($1,'b','Engineer','forward','applied') returning applied_at",[id]))[0];
 assert.equal(forwarded.applied_at,null);
 await db.query('delete from public.subscriptions where id=$1',[id]);
 assert.equal((await query('select count(*)::int as n from public.offers'))[0].n,0);
 } finally { await db.close(); }
});

test('public login codes have atomic reservation, one-time use and rolling rate limits', async()=>{
 const db=new PGlite();
 try{
 await db.exec('create role anon; create role authenticated; create role service_role bypassrls;');
 for(const file of (await readdir('supabase/migrations')).sort()) await db.exec(await readFile('supabase/migrations/'+file,'utf8'));
 const q=async(sql,params=[]) => (await db.query(sql,params)).rows[0];
 const hash='a'.repeat(64),wrong='b'.repeat(64);
 assert.equal((await q("select has_function_privilege('anon','public.reserve_login_code(text,text)','execute') as allowed")).allowed,false);
 assert.equal((await q("select has_function_privilege('authenticated','public.consume_login_code(text,text)','execute') as allowed")).allowed,false);
 await db.exec('set role service_role');
 const reserve=async(email)=> (await q('select reserve_login_code($1,$2) as r',[email,hash])).r;
 const consume=async(email,h)=> (await q('select consume_login_code($1,$2) as r',[email,h])).r;
 assert.equal(await reserve('new@example.org'),'ok');
 assert.equal(await reserve('new@example.org'),'wait');
 assert.equal((await consume('new@example.org',wrong)).left,4);
 assert.equal((await consume('new@example.org',hash)).status,'ok');
 assert.equal((await consume('new@example.org',hash)).status,'expired');
 assert.equal(await reserve('new@example.org'),'wait');
 assert.equal((await q("select code_hash from public.login_codes where email='new@example.org'")).code_hash,'0'.repeat(64));
 assert.equal(await reserve('locked@example.org'),'ok');
 for(let i=0;i<5;i++) await consume('locked@example.org',wrong);
 assert.equal((await consume('locked@example.org',hash)).status,'locked');
 for(let i=0;i<28;i++) assert.equal(await reserve('quota'+i+'@example.org'),'ok');
 assert.equal(await reserve('overflow@example.org'),'service_busy');
 }finally{await db.close();}
});
