'use strict';
// A read-only gate. Test personas are never inserted into platform_users or live lists.
const response=(statusCode,body)=>({statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store',Vary:'Authorization','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)});
exports.handler=async event=>{
  if(event.httpMethod!=='POST')return response(405,{message:'Method not allowed.'});
  const token=/^Bearer\s+(.+)$/i.exec(event.headers?.authorization||event.headers?.Authorization||'')?.[1];
  if(!token)return response(401,{message:'Sign in to open Test Mode.'});
  if(event.isBase64Encoded||event.body!=='{}'||Object.keys(event.queryStringParameters||{}).length)return response(400,{message:'Unsupported request.'});
  const url=String(process.env.SUPABASE_URL||'').trim().replace(/\/$/,''),key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SECRET_KEY||'').trim();
  if(!/^https:\/\/[^/]+\.supabase\.co$/.test(url)||!key)return response(503,{message:'Test Mode is temporarily unavailable.'});
  try{
    const auth=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`}}),user=await auth.json();
    if(!auth.ok||!/^[0-9a-f-]{36}$/i.test(user.id||''))return response(401,{message:'Sign in again to open Test Mode.'});
    const result=await fetch(`${url}/rest/v1/platform_users?id=eq.${encodeURIComponent(user.id)}&select=role,is_founder,active,must_change_password&limit=1`,{headers:{apikey:key,...(!key.startsWith('sb_secret_')?{Authorization:`Bearer ${key}`}:{})}});
    if(!result.ok)throw new Error('Access unavailable');
    const rows=await result.json(),access=rows[0];
    if(access?.role!=='admin'||access.is_founder!==true||access.active!==true||access.must_change_password!==false)return response(403,{message:'Test Mode is available only to the Founder.'});
    return response(200,{allowed:true,roles:['client','talent','sales','va']});
  }catch{return response(503,{message:'Test Mode is temporarily unavailable.'});}
};
