/* Authenticated, read-only Client home. The shared contract copies only an
 * explicit allowlist and validates roles, counts, identifiers and Teams URLs. */
const { normalizeWorkspace } = require('../../operations/client-dashboard.js');
const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl) ? configuredUrl.replace(/\/$/, '') : '';
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();
const failure = (status, code, message) => Object.assign(new Error(message), { status, code });
function json(statusCode, body, extra={}) { return {statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',Vary:'Authorization',...extra},body:JSON.stringify(body)}; }
async function handler(event) {
  if(event.httpMethod !== 'GET') return json(405,{code:'method_not_allowed',message:'Method not allowed.'},{Allow:'GET'});
  try {
    if(Object.keys(event.queryStringParameters||{}).length || Object.keys(event.multiValueQueryStringParameters||{}).length || String(event.rawQueryString||'').trim() || String(event.body||'').trim()) throw failure(400,'unsupported_scope','Dashboard access comes from your signed-in account.');
    const token=/^Bearer\s+(.+)$/i.exec(event.headers?.authorization||event.headers?.Authorization||'')?.[1]?.trim();
    if(!token) throw failure(401,'authentication_required','Sign in to view your dashboard.');
    if(!SUPABASE_URL||!SERVICE_KEY) throw failure(503,'service_unavailable','Dashboard unavailable.');
    const auth=await fetch(`${SUPABASE_URL}/auth/v1/user`,{headers:{apikey:SERVICE_KEY,Authorization:`Bearer ${token}`}});
    if(!auth.ok) throw [401,403].includes(auth.status)?failure(401,'authentication_required','Sign in again to view your dashboard.'):failure(503,'service_unavailable','Dashboard unavailable.');
    const user=await auth.json().catch(()=>null);
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user?.id||'')) throw failure(401,'authentication_required','Sign in again to continue.');
    const response=await fetch(`${SUPABASE_URL}/rest/v1/rpc/get_client_dashboard`,{method:'POST',headers:{apikey:SERVICE_KEY,...(SERVICE_KEY.startsWith('sb_secret_')?{}:{Authorization:`Bearer ${SERVICE_KEY}`}), 'Content-Type':'application/json'},body:JSON.stringify({p_actor_user_id:user.id})});
    const payload=await response.json().catch(()=>null);
    if(!response.ok) throw payload?.code==='42501'?failure(403,'dashboard_forbidden','This account cannot view the Client dashboard.'):failure(503,'service_unavailable','Dashboard unavailable.');
    try { return json(200,normalizeWorkspace(payload)); } catch { throw failure(502,'dashboard_response_invalid','Dashboard unavailable.'); }
  } catch(error) {const status=Number.isInteger(error.status)?error.status:500;return json(status,{code:error.code||'dashboard_unavailable',message:status>=500?'Your dashboard is temporarily unavailable. Please try again.':error.message});}
}
exports.handler=handler;
exports.publicPayload=normalizeWorkspace;
