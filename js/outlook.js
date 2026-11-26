// Microsoft Graph: delegated read-only, short-lived in-memory access only.
// No client secret, refresh token, mailbox password, or provider token is persisted.
export const REDIRECT = 'https://rdzoagbe.github.io/veille-emploi/';
const AUTH='https://login.microsoftonline.com/common/oauth2/v2.0/';
const GRAPH='https://graph.microsoft.com/v1.0';
const SCOPES='https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read';
const KEY='ve:outlook-pkce';
const MAX_AGE=600000;
const norm=v=>String(v||'').trim().toLowerCase();
export const validClientId=v=>typeof v==='string'&&/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v);
function b64(bytes){return btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const digest=async v=>b64(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v))));
export function takeCallback(location,history){
  const url=new URL(location.href);
  const hash=new URLSearchParams(url.hash.slice(1));
  const params=(hash.has('state')&&(hash.has('code')||hash.has('error')))?hash:((url.searchParams.has('state')&&(url.searchParams.has('code')||url.searchParams.has('error')))?url.searchParams:null);
  if(!params)return null;
  const callback={state:params.get('state'),code:params.get('code'),error:params.has('error')};
  if(params===hash)url.hash='';
  else for(const k of ['code','state','error','error_description','error_uri','session_state','client_info','correlation_id'])url.searchParams.delete(k);
  history.replaceState(null,'',url.pathname+url.search+url.hash);
  return callback;
}
export async function beginOutlook({clientId,session,email,storage}){
  if(!validClientId(clientId)||!session||!email)throw Error('outlookUnavailable');
  const state=random(),verifier=random(),sessionHash=await digest(session);
  storage.setItem(KEY,JSON.stringify({state,verifier,sessionHash,clientId,created:Date.now()}));
  const url=new URL(AUTH+'authorize');
  url.search=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:REDIRECT,response_mode:'fragment',scope:SCOPES,state,code_challenge:await digest(verifier),code_challenge_method:'S256',prompt:'select_account',login_hint:email}).toString();
  return url.href;
}
export function clearOutlookPending(storage){try{storage.removeItem(KEY);}catch{}}
async function graph(url,token,fetcher=fetch){
  const r=await fetcher(url,{headers:{Authorization:'Bearer '+token,Prefer:'outlook.body-content-type="text"'},cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error(r.status===401?'outlookExpired':'outlookFailed');
  return r.json();
}
export function graphPage(next,expectedPath){
  if(!next)return null;
  const u=new URL(next);
  if(u.origin!=='https://graph.microsoft.com'||u.username||u.password||u.pathname!==expectedPath||u.hash)throw Error('outlookFailed');
  return u.href;
}
export async function finishOutlook({callback,clientId,session,email,storage,fetcher=fetch}){
  let p;try{p=JSON.parse(storage.getItem(KEY)||'null');}finally{clearOutlookPending(storage);}
  if(!p||!callback||!validClientId(clientId)||!session||p.clientId!==clientId||p.state!==callback.state||p.sessionHash!==await digest(session)||!Number.isFinite(p.created)||Date.now()-p.created>MAX_AGE||p.created>Date.now()||!/^[A-Za-z0-9_-]{43}$/.test(p.verifier||''))throw Error('outlookInvalid');
  if(callback.error||!callback.code)throw Error('outlookCancelled');
  const r=await fetcher(AUTH+'token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,grant_type:'authorization_code',code:callback.code,redirect_uri:REDIRECT,code_verifier:p.verifier,scope:SCOPES}),cache:'no-store',redirect:'error',signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw Error('outlookFailed');
  const result=await r.json();
  const ttl=Number(result.expires_in);
  const scope=String(result.scope||'').toLowerCase().split(/\s+/).map(s=>s.split('/').at(-1));
  if(typeof result.access_token!=='string'||!result.access_token||norm(result.token_type)!=='bearer'||!Number.isFinite(ttl)||ttl<=60||!scope.includes('mail.read')||!scope.includes('user.read'))throw Error('outlookFailed');
  const profile=await graph(GRAPH+'/me?$select=mail,userPrincipalName',result.access_token,fetcher);
  if(norm(profile.mail||profile.userPrincipalName)!==norm(email))throw Error('outlookMismatch');
  return {token:result.access_token,expires:Date.now()+Math.min(ttl,3600)*1000-30000,session,clientId,folder:null,next:null};
}
export function isConnected(connection,session,clientId){
  return !!connection&&connection.session===session&&connection.clientId===clientId&&connection.expires>Date.now();
}
async function findFolder(connection,fetcher){
  let url=GRAPH+'/me/mailFolders?$select=id,displayName&$top=100',found=[];
  for(let i=0;i<10&&url;i++){
    const page=await graph(url,connection.token,fetcher);
    if(!Array.isArray(page.value))throw Error('outlookFailed');
    found.push(...page.value.filter(f=>norm(f.displayName)==='veille-candidatures'&&typeof f.id==='string'&&f.id.length>0));
    url=graphPage(page['@odata.nextLink'],'/v1.0/me/mailFolders');
  }
  if(url||found.length>1)throw Error('outlookFailed');
  if(found.length!==1)throw Error('outlookNoFolder');
  return found[0].id;
}
export async function outlookPage(connection,fetcher=fetch){
  if(!connection||connection.expires<=Date.now())throw Error('outlookExpired');
  const folder=connection.folder||await findFolder(connection,fetcher);
  const path='/v1.0/me/mailFolders/'+encodeURIComponent(folder)+'/messages';
  const url=new URL('https://graph.microsoft.com'+path);
  url.search=new URLSearchParams({'$top':'20','$select':'id,subject,body,from,receivedDateTime','$filter':'receivedDateTime ge '+new Date(Date.now()-90*86400000).toISOString(),'$orderby':'receivedDateTime desc'}).toString();
  const page=await graph(connection.next?graphPage(connection.next,path):url.href,connection.token,fetcher);
  if(!Array.isArray(page.value)||page.value.length>20)throw Error('outlookFailed');
  const messages=page.value.map(m=>{
    if(norm(m.body?.contentType)!=='text')return null;
    return {subject:String(m.subject||'').slice(0,500),text:String(m.body?.content||'').slice(0,12000),date:String(m.receivedDateTime||'').slice(0,40),fromName:String(m.from?.emailAddress?.name||'').slice(0,200),fromAddress:String(m.from?.emailAddress?.address||'').slice(0,320)};
  });
  return {folder,messages,next:graphPage(page['@odata.nextLink'],path)};
}
