'use strict';
// Server-derived identity only: clients never supply an actor, role, or organization.
const url = String(process.env.SUPABASE_URL || '').trim().replace(/\/$/, '');
const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROFILE_FIELDS = Object.freeze(['full_name','contact_email','phone','hire_date','address_line_1','address_line_2','city','state_region','postal_code','country','business_email','business_phone']);
const KEYS = Object.freeze({
  account_read: ['action'], account_save: ['action','profile','expectedUpdatedAt'],
  ownership_read: ['action','kind','entityId'],
  ownership_save: ['action','kind','entityId','field','ownerId','requestId','expectedUpdatedAt'],
  duplicate_audit: ['action','sourceId'],
  duplicate_retire: ['action','sourceId','fingerprint','expectedEmail','expectedName']
});
function error(status,message) { return Object.assign(new Error(message),{status}); }
function exact(value,keys) { return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length && Object.keys(value).every(k=>keys.includes(k)); }
function validate(body) {
  if (!KEYS[body?.action] || !exact(body,KEYS[body.action])) throw error(400,'Only the requested account or ownership fields are accepted.');
  if (body.action.endsWith('_save') && (typeof body.expectedUpdatedAt!=='string' || body.expectedUpdatedAt.length>40 || !Number.isFinite(Date.parse(body.expectedUpdatedAt)))) throw error(400,'Reload the record before saving.');
  if (body.action==='account_save') {
    if (!exact(body.profile,PROFILE_FIELDS) || Object.values(body.profile).some(v=>v!==null && (typeof v!=='string' || v.length>254))) throw error(400,'Enter valid account details.');
  }
  if (body.action.startsWith('ownership_')) {
    if (!['talent','client'].includes(body.kind) || !UUID.test(body.entityId)) throw error(400,'Choose a valid profile.');
    if (body.action==='ownership_save' && (!UUID.test(body.requestId) || (body.ownerId!==null && !UUID.test(body.ownerId)) || !['review','support','sales'].includes(body.field) || (body.kind==='client' && body.field!=='sales'))) throw error(400,'Choose a supported ownership change.');
  }
  if (body.action.startsWith('duplicate_')) {
    if (!UUID.test(body.sourceId)) throw error(400,'Choose the duplicate employee.');
    if (body.action==='duplicate_retire' && (!/^[a-f0-9]{32}$/.test(body.fingerprint)||typeof body.expectedEmail!=='string'||body.expectedEmail.length>254||typeof body.expectedName!=='string'||body.expectedName.length>180)) throw error(400,'Review the duplicate account before confirming.');
  }
  return body;
}
function reply(statusCode,body) { return {statusCode,headers:{'Content-Type':'application/json','Cache-Control':'no-store',Pragma:'no-cache',Vary:'Authorization','X-Content-Type-Options':'nosniff'},body:JSON.stringify(body)}; }
async function handler(event) {
  if (event.httpMethod!=='POST') return reply(405,{message:'Method not allowed.'});
  try {
    if (!/^https:\/\/[^/]+\.supabase\.co$/.test(url) || !key) throw error(503,'Account management is temporarily unavailable.');
    if (String(event.rawQueryString||'') || Object.keys(event.queryStringParameters||{}).length || Object.keys(event.multiValueQueryStringParameters||{}).length || event.isBase64Encoded || Buffer.byteLength(event.body||'')>8192) throw error(400,'Unsupported request.');
    let body; try { body=validate(JSON.parse(event.body||'{}')); } catch(e) { throw e.status?e:error(400,'Invalid request.'); }
    const token=/^Bearer\s+(.+)$/i.exec(event.headers?.authorization||event.headers?.Authorization||'')?.[1];
    if (!token) throw error(401,'Sign in again to continue.');
    const auth=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:`Bearer ${token}`}});
    const user=await auth.json().catch(()=>({}));
    if (!auth.ok || !UUID.test(user.id)) throw error(401,'Sign in again to continue.');
    const headers={apikey:key,'Content-Type':'application/json',...(!key.startsWith('sb_secret_')?{Authorization:`Bearer ${key}`}:{})};
    // SQL independently checks the actual active role and organization on every call.
    const rpc=body.action.startsWith('duplicate_')?(body.action==='duplicate_audit'?'audit_staff_duplicate':'retire_staff_duplicate'):body.action.startsWith('account_')?'founder_account_profile':body.action==='ownership_read'?'get_staff_ownership':'change_staff_ownership';
    const input=body.action.startsWith('duplicate_')?{p_actor_user_id:user.id,p_source_user_id:body.sourceId,...(body.action==='duplicate_retire'?{p_expected_fingerprint:body.fingerprint,p_expected_email:body.expectedEmail,p_expected_name:body.expectedName}:{})}:body.action.startsWith('account_')?{p_actor_user_id:user.id,p_action:body.action==='account_read'?'read':'save',p_payload:body.profile||{},p_expected_updated_at:body.expectedUpdatedAt||null}:
      {p_actor_user_id:user.id,p_kind:body.kind,p_entity_id:body.entityId,...(body.action==='ownership_save'?{p_request_id:body.requestId,p_expected_updated_at:body.expectedUpdatedAt,p_field:body.field,p_owner_id:body.ownerId}:{})};
    const response=await fetch(`${url}/rest/v1/rpc/${rpc}`,{method:'POST',headers,body:JSON.stringify(input)});
    const result=await response.json().catch(()=>({}));
    if (!response.ok) {
      const status=result.code==='42501'?403:result.code==='40001'?409:['22023','23502','23514','23505','22007','22008','P0001'].includes(result.code)?400:503;
      throw error(status,status===503?'This feature needs its database update before it can be used.':result.code?.startsWith('23')?'Check the contact details and try again.':result.message||'The change could not be saved.');
    }
    return reply(200,result);
  } catch(e) { return reply(e.status||503,{message:e.status?e.message:'Account management is temporarily unavailable.'}); }
}
exports.handler=handler;
exports.validate=validate;
exports.PROFILE_FIELDS=PROFILE_FIELDS;
