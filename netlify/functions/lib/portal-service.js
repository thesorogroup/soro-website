'use strict';
const fail = (status,message) => Object.assign(new Error(message),{status});
function config() {
  const url=String(process.env.SUPABASE_URL||'').trim().replace(/\/$/,'');
  const key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY||'').trim();
  if(!/^https:\/\/[^/]+\.supabase\.co$/.test(url)||!key)throw fail(503,'Service temporarily unavailable.');
  return {url,key};
}
async function service(path,options={}) {
  const {url,key}=config();
  return fetch(`${url}${path}`,{...options,signal:options.signal||AbortSignal.timeout(12000),headers:{apikey:key,...(key.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${key}`}),...options.headers}});
}
async function rpc(name,body,timeout=12000) {
  const response=await service(`/rest/v1/rpc/${name}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(timeout)});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw fail(data?.code==='42501'?403:['23505','40001'].includes(data?.code)?409:['22023','23514'].includes(data?.code)?400:503,
    data?.code==='40001'?'This ticket was updated by someone else. Refresh the ticket, then try again.':data?.code==='23505'?'This submission changed. Start a new request before trying again.':data?.code==='42501'?'This account cannot perform that action on this ticket.':'The request could not be completed. Please try again.');
  return data;
}
async function actor(event) {
  const {url,key}=config();
  const token=/^Bearer\s+(.+)$/i.exec(event.headers?.authorization||event.headers?.Authorization||'')?.[1];
  if(!token)throw fail(401,'Sign in to continue.');
  const response=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
  const user=await response.json().catch(()=>null);
  if(!response.ok||!uuid(user?.id))throw fail(401,'Sign in again to continue.');
  return user.id;
}
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const json=(statusCode,body)=>({statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',Vary:'Authorization'},body:JSON.stringify(body)});
module.exports={fail,config,service,rpc,actor,uuid,json};
