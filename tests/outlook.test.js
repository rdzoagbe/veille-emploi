import test from 'node:test';
import assert from 'node:assert/strict';
import {beginOutlook,finishOutlook,takeCallback,graphPage,outlookPage,isConnected,REDIRECT} from '../js/outlook.js';
const clientId='12345678-1234-1234-1234-123456789abc',session='a'.repeat(64),email='test@example.org';
function storage(){const m=new Map();return{setItem:(k,v)=>m.set(k,v),getItem:k=>m.get(k)||null,removeItem:k=>m.delete(k),size:()=>m.size};}
const response=data=>({ok:true,status:200,json:async()=>data});
async function start(st){const url=new URL(await beginOutlook({clientId,session,email,storage:st}));return {url,callback:{state:url.searchParams.get('state'),code:'synthetic-code',error:false}};}
test('Outlook authorization uses PKCE S256, exact redirect and no secret or write permission',async()=>{
 const st=storage(),{url}=await start(st);
 assert.equal(url.origin,'https://login.microsoftonline.com');assert.equal(url.searchParams.get('redirect_uri'),REDIRECT);
 assert.equal(url.searchParams.get('response_type'),'code');assert.equal(url.searchParams.get('code_challenge_method'),'S256');
 assert.match(url.searchParams.get('code_challenge'),/^[A-Za-z0-9_-]{43}$/);
 assert.match(url.searchParams.get('state'),/^[A-Za-z0-9_-]{43}$/);
 assert.equal(url.searchParams.has('client_secret'),false);
 assert.doesNotMatch(url.searchParams.get('scope'),/Mail.ReadWrite|Mail.Send|offline_access/);
 assert.equal(url.searchParams.get('response_mode'),'fragment');
});
test('OAuth response is stripped from the browser address immediately',()=>{
 let replaced;const cb=takeCallback({href:REDIRECT+'#code=synthetic&state=state-value'}, {replaceState:(_,__,v)=>replaced=v});
 assert.deepEqual(cb,{code:'synthetic',state:'state-value',error:false});assert.equal(replaced,'/veille-emploi/');
});
test('valid authorization only accepts matching verified app email and consumes pending state',async()=>{
 const st=storage(),{callback}=await start(st);const calls=[];
 const fetcher=async(url,opts)=>{calls.push([url,opts]);return String(url).endsWith('/token')?response({access_token:'test-token',refresh_token:'never-store',token_type:'Bearer',scope:'User.Read Mail.Read',expires_in:3600}):response({mail:email});};
 const conn=await finishOutlook({callback,clientId,session,email,storage:st,fetcher});
 assert.equal(st.size(),0);assert.equal(conn.token,'test-token');assert.equal(conn.refresh_token,undefined);
 assert.equal(isConnected(conn,session,clientId),true);assert.equal(isConnected(conn,'different',clientId),false);
 assert.equal(calls[0][1].body.has('client_secret'),false);assert.equal(calls[1][1].headers.Authorization,'Bearer test-token');
 await assert.rejects(()=>finishOutlook({callback,clientId,session,email,storage:st,fetcher}),/outlookInvalid/);
 assert.equal(calls.length,2);
});
test('wrong state, switched app session and wrong mailbox cannot connect',async()=>{
 const st=storage();let a=await start(st),calls=0;
 const fetcher=async url=>{calls++;return String(url).endsWith('/token')?response({access_token:'test',token_type:'Bearer',scope:'Mail.Read User.Read',expires_in:3600}):response({mail:'other@example.org'});};
 await assert.rejects(()=>finishOutlook({callback:{...a.callback,state:'wrong'},clientId,session,email,storage:st,fetcher}),/outlookInvalid/);assert.equal(calls,0);
 a=await start(st);await assert.rejects(()=>finishOutlook({callback:a.callback,clientId,session:'other',email,storage:st,fetcher}),/outlookInvalid/);assert.equal(calls,0);
 a=await start(st);await assert.rejects(()=>finishOutlook({callback:a.callback,clientId,session,email,storage:st,fetcher}),/outlookMismatch/);assert.equal(st.size(),0);
});
test('folder reader only reads designated folder and does not accept arbitrary next links',async()=>{
 const calls=[];const c={token:'synthetic',expires:Date.now()+60000,folder:null,next:null};
 const fetcher=async url=>{calls.push(String(url));return String(url).includes('/messages?')?response({value:[{subject:'Role',body:{contentType:'text',content:'Confirmation'},from:{emailAddress:{address:'jobs@example.org'}},receivedDateTime:'2026-11-25T10:00:00Z'}]}):response({value:[{id:'inbox',displayName:'Inbox'},{id:'wanted',displayName:'veille-candidatures'}]});};
 const p=await outlookPage(c,fetcher);assert.equal(p.folder,'wanted');assert.equal(p.messages.length,1);assert.equal(p.messages[0].text,'Confirmation');assert.equal(calls.length,2);assert.match(calls[1],/\/mailFolders\/wanted\/messages/);assert.ok(!calls.some(x=>x.includes('/mailFolders/inbox/')));
 assert.throws(()=>graphPage('https://example.org/v1.0/me/mailFolders','/v1.0/me/mailFolders'),/outlookFailed/);
 assert.throws(()=>graphPage('https://graph.microsoft.com/v1.0/me/messages','/v1.0/me/mailFolders'),/outlookFailed/);
});
test('missing dedicated folder never falls back to the inbox',async()=>{
 const c={token:'synthetic',expires:Date.now()+60000};let n=0;
 await assert.rejects(()=>outlookPage(c,async()=>{n++;return response({value:[{id:'inbox',displayName:'Inbox'}]});}),/outlookNoFolder/);
 assert.equal(n,1);
});
