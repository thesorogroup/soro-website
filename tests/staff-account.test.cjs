'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=path.join(__dirname,'..'),read=p=>fs.readFileSync(path.join(base,p),'utf8');
const endpoint=path.join(base,'netlify/functions/staff-account.js');
const id='10000000-0000-4000-8000-000000000010',entity='10000000-0000-4000-8000-000000000020';
function api(){process.env.SUPABASE_URL='https://staff-fixture.supabase.co';process.env.SUPABASE_SERVICE_ROLE_KEY='sb_secret_fixture_only';delete require.cache[require.resolve(endpoint)];return require(endpoint);}
test('staff requests reject actor, organization, role and arbitrary profile target injection',()=>{
 const {validate,PROFILE_FIELDS}=api(),profile=Object.fromEntries(PROFILE_FIELDS.map(key=>[key,null]));
 for(const extra of [{actorId:id},{organizationId:id},{role:'admin'},{userId:id}])assert.throws(()=>validate({action:'account_read',...extra}));
 assert.throws(()=>validate({action:'account_save',profile:{...profile,is_founder:true},expectedUpdatedAt:new Date().toISOString()}));
 assert.throws(()=>validate({action:'ownership_save',kind:'client',entityId:entity,field:'review',ownerId:id,requestId:id,expectedUpdatedAt:new Date().toISOString()}));
 assert.throws(()=>validate({action:'duplicate_retire',sourceId:id,fingerprint:'bad',expectedEmail:'example@example.test',expectedName:'Example'}));
});
test('verified authentication identity is the only RPC actor; auth failure never calls ownership SQL',async()=>{
 const previous=global.fetch,calls=[];
 try{
  const {handler}=api();
  global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.includes('/auth/')?{id}:{record:{id:entity}}};};
  const event={httpMethod:'POST',headers:{authorization:'Bearer fixture-token'},body:JSON.stringify({action:'ownership_read',kind:'talent',entityId:entity})};
  let result=await handler(event);assert.equal(result.statusCode,200);assert.deepEqual(JSON.parse(calls[1].options.body),{p_actor_user_id:id,p_kind:'talent',p_entity_id:entity});assert.equal(result.headers['Cache-Control'],'no-store');
  calls.length=0;global.fetch=async()=>({ok:false,json:async()=>({})});result=await handler(event);assert.equal(result.statusCode,401);assert.equal(calls.length,0);
 }finally{global.fetch=previous;}
});
test('staff endpoint preserves actionable stale/security errors without exposing internal failures',async()=>{
 const previous=global.fetch;
 try{const {handler}=api();for(const [code,status]of [['42501',403],['40001',409],['XX000',503]]){
  global.fetch=async url=>({ok:url.includes('/auth/'),json:async()=>url.includes('/auth/')?{id}:{code,message:code==='XX000'?'private internal detail':'Reload first'}});
  const result=await handler({httpMethod:'POST',headers:{authorization:'Bearer fixture'},body:'{"action":"account_read"}'});assert.equal(result.statusCode,status);assert.doesNotMatch(result.body,/private internal detail/);
 }}finally{global.fetch=previous;}
});
test('Founder-only sparse HR profiles retain existing ordinary employee required fields and login identity',()=>{
 const sql=read('supabase/migrations/20260909_056_founder_account_profile.sql');
 assert.match(sql,/require_employee_profile_details/);assert.match(sql,/not exists[\s\S]*is_founder[\s\S]*new.phone is null/);
 assert.match(sql,/for update/);assert.match(sql,/p.updated_at is distinct from p_expected_updated_at/);
 assert.doesNotMatch(sql,/update auth.users|set role=|set is_founder=/i);
 assert.match(sql,/changed_fields/);assert.match(sql,/from public,anon,authenticated/);
});
test('ownership remains Admin scoped and eligibility changes cannot rewrite actor authorization',()=>{
 const sql=read('supabase/migrations/20260909_057_administrator_ownership.sql');
 assert.match(sql,/active and not must_change_password for share/);assert.match(sql,/role='admin'::public.platform_role/);
 assert.match(sql,/regexp_replace\(patched,'\\m'/);assert.doesNotMatch(sql,/array\['v_actor'/);
 assert.match(sql,/auth.role\(\) is distinct from 'service_role'/);assert.match(sql,/soro.ownership_client/);
 assert.match(sql,/Scheduled|scheduled/);assert.match(sql,/p_expected_updated_at/);assert.match(sql,/prior.fingerprint<>fingerprint/);
});
test('duplicate retirement preserves history and refuses incomplete transfers',()=>{
 const sql=read('supabase/migrations/20260909_058_retire_duplicate_staff.sql');
 assert.match(sql,/pg_constraint/);assert.match(sql,/Global residual checks/);assert.match(sql,/zz_support_retired_owner/);
 assert.match(sql,/confirmation_outbox[\s\S]*status in \('pending','sending'\) order by id for update/);
 assert.match(sql,/public.change_staff_ownership/);assert.match(sql,/active=false,retired_into_user_id/);
 assert.doesNotMatch(sql,/delete from|update auth.users|set created_by_user_id|set actor_user_id/i);
 assert.match(sql,/status='open'/);assert.match(sql,/payroll records/i);
});
test('body-mounted staff dialogs are invalidated on auth changes and refresh committed data after close',()=>{
 const ui=read('operations/staff-account.js'),auth=read('operations/auth.js');
 assert.match(ui,/must_change_password!==true/);assert.match(ui,/generation\+\+;for\(const dialog of dialogs\)dialog.close/);
 assert.match(ui,/scope\(\)!==captured/);assert.match(ui,/aria-labelledby/);
 assert.ok(ui.indexOf("root.dispatchEvent(new CustomEvent('soro:staff-account-updated'")<ui.indexOf("form.querySelector('[role=\"status\"]').textContent='Account details saved"));
 for(const fn of ['showRequiredPasswordChange','showPasswordRecovery'])assert.match(auth.slice(auth.indexOf(`function ${fn}(`),auth.indexOf(`function ${fn}(`)+400),/soro-auth-changed/);
});
test('navigation releases the queue root before Employees and other wrapper views render',()=>{
 assert.match(read('operations/operations.js'),/function setActive\(\)\{\s*if\(current!=='talent-review'\)window.soroTalentReviewQueue\?\.unmount/);
 assert.match(read('operations/admin-employee-management.js'),/version !== employeeLoadVersion \|\| scope !== employeeScope/);
 assert.match(read('operations/talent-review-queue.js'),/!notStarted && actualRole\(\) === 'admin'/);
 assert.match(read('operations/talent-review-queue.js'),/holdReview\(reassignButton.dataset.reviewReassign\)/);
});
