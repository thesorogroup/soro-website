'use strict';
// Explicit observer endpoint. No target credentials, auth mutations, or arbitrary RPC dispatch.
const {actor,service,rpc,uuid,json,fail,config}=require('./lib/portal-service');
const CLIENT_ROLES=['client_admin','client_reviewer','client_billing'];
const SELF_FIELDS='id,organization_id,auth_user_id,full_name,preferred_name,birth_date,gender_identity,gender_identity_self_description,pronouns,pronouns_self_description,email,phone,location,country,address_line_1,address_line_2,city,province_region,postal_code,timezone,timezone_other_detail,status,work_status,work_status_other_detail,availability_note,expected_hourly_rate,expected_hourly_rate_max,expected_hourly_rate_text,greatest_dream,dedicated_workspace,has_laptop,equipment_summary,internet_summary,english_test_result,personality_profile_score,computer_specs,internet_speed,application_received_at,submitted_at,verified_skills,self_reported_experience_areas,self_reported_skills,other_experience_specialty,relevant_experience_years,relevant_experience_summary,education_training_summary,skill_profile_updated_at,education_level,loom_video_url';
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
async function rows(path){const r=await service('/rest/v1/'+path);const v=await r.json().catch(()=>null);if(!r.ok||!Array.isArray(v))throw fail(503,'The live portal data could not be loaded.');return v;}
async function founder(event){
 const id=await actor(event),a=(await rows('platform_users?id=eq.'+id+'&select=id,organization_id,role,is_founder,active,must_change_password&limit=1'))[0];
 if(a?.role!=='admin'||a.is_founder!==true||a.active!==true||a.must_change_password!==false||!uuid(a.organization_id))throw fail(403,'Live portal observation is available only to the Founder.');return a;
}
async function context(a,portal,id){
 if(!uuid(id))throw fail(400,'Choose an active portal account.');
 const u=(await rows(`platform_users?id=eq.${id}&organization_id=eq.${a.organization_id}&active=is.true&must_change_password=is.false&select=id,organization_id,role,display_name&limit=1`))[0];
 if(!u||(portal==='client'?!CLIENT_ROLES.includes(u.role):u.role!=='virtual_assistant'))throw fail(403,'This account is not available in the selected portal.');
 const c={actorId:a.id,user:{id:u.id},access:u,subject:{...u,user_id:u.id,is_founder:false,active:true,must_change_password:false,read_only_observer:true}};
 if(portal==='client'){
  const m=await rows(`client_portal_memberships?user_id=eq.${u.id}&organization_id=eq.${a.organization_id}&active=is.true&select=user_id,organization_id,client_id,client_contact_id&limit=2`);
  if(m.length!==1)throw fail(404,'The Client account needs one active portal connection.');c.membership=m[0];
  const clients=await rows(`clients?id=eq.${m[0].client_id}&organization_id=eq.${a.organization_id}&archived_at=is.null&select=id&limit=1`);
  const contacts=await rows(`client_contacts?id=eq.${m[0].client_contact_id}&client_id=eq.${m[0].client_id}&organization_id=eq.${a.organization_id}&active=is.true&select=id&limit=1`);
  if(clients.length!==1||contacts.length!==1)throw fail(404,'The Client account is no longer active.');
 }else{
  const t=await rows(`applicants?auth_user_id=eq.${u.id}&organization_id=eq.${a.organization_id}&archived_at=is.null&portal_access_status=eq.active&select=id&limit=2`);
  if(t.length!==1)throw fail(404,'The Talent account needs one active profile connection.');c.applicantId=t[0].id;
 }
 // Read only the login email for display; no session or credential is created for the subject.
 const identityResponse=await service('/auth/v1/admin/users/'+u.id),identity=await identityResponse.json().catch(()=>null);
 if(!identityResponse.ok||identity?.id!==u.id)throw fail(503,'The selected portal account could not be verified.');
 c.subject.email=String(identity.email||'');
 return c;
}
async function accounts(a,portal){
 const users=await rows(`platform_users?organization_id=eq.${a.organization_id}&active=is.true&must_change_password=is.false&role=in.(${portal==='client'?CLIENT_ROLES.join(','):'virtual_assistant'})&select=id,display_name&order=display_name&limit=1001`);
 if(users.length>1000)throw fail(409,'Too many portal accounts to display.');
 const linked=await rows(portal==='client'?`client_portal_memberships?organization_id=eq.${a.organization_id}&active=is.true&select=user_id,client_id&limit=5000`:`applicants?organization_id=eq.${a.organization_id}&archived_at=is.null&portal_access_status=eq.active&select=auth_user_id,full_name&limit=5000`);
 const companies=portal==='client'?await rows(`clients?organization_id=eq.${a.organization_id}&archived_at=is.null&select=id,company_name&limit=5000`):[];
 return users.flatMap(u=>{const links=linked.filter(l=>(l.user_id||l.auth_user_id)===u.id);if(links.length!==1)return[];const name=portal==='client'?companies.find(c=>c.id===links[0].client_id)?.company_name:links[0].full_name;if(!name)return[];return[{id:u.id,label:portal==='client'?`${name} · ${u.display_name||'Client Contact'}`:name}];});
}
function check(p,keys){if(!exact(p,keys)||Object.values(p).some(v=>typeof v!=='string'||v.length>4000))throw fail(400,'Unsupported live view filter.');}
function id(value){if(!uuid(value))throw fail(400,'Choose a valid record.');return value;}
async function signed(file){
 const helpers=require('./document-center')._test;
 const r=await service('/storage/v1/object/sign/'+helpers.pathFor(file),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:60})}),v=await r.json();
 if(!r.ok||!v.signedURL)throw fail(503,'The private file could not be opened.');return{url:helpers.storageURL(v.signedURL,'sign'),expiresIn:60};
}
async function read(c,resource,p){
 const subject=c.user.id,call=(name,extra={})=>rpc(name,{p_actor_user_id:subject,...extra});
 const privateRead=(name,params={})=>rpc('founder_portal_private_read',{p_actor_user_id:c.actorId,p_subject_user_id:subject,p_resource:name,p_params:params});
 const talent=()=>{if(c.access.role!=='virtual_assistant')throw fail(403,'This is a Talent-only view.');};
 const client=()=>{if(!CLIENT_ROLES.includes(c.access.role))throw fail(403,'This is a Client-only view.');};
 switch(resource){
  case 'client-dashboard':check(p,[]);client();return require('./client-dashboard').publicPayload(await call('get_client_dashboard'));
  case 'client-profile':check(p,[]);client();return require('./client-profile').loadSafeProfile(c);
  case 'client-talent-profile':check(p,[]);client();if(c.access.role==='client_billing')throw fail(403,'This account cannot view Talent.');{const talents=await require('./client-talent-profile').loadAssignedTalents(c);return{talents,count:talents.length,presentation:{tabs:['profile'],readOnly:true,documentsAvailable:false,sourceFilesAvailable:false}};}
  case 'client-shortlists':check(p,[]);client();return require('./client-shortlists').publicPayload(await call('get_client_shortlist_workspace'));
  case 'client-placement-workflow':check(p,['hiringRequestId']);client();return require('./client-placement-workflow').publicPayload(await call('get_client_placement_workspace',{p_hiring_request_id:id(p.hiringRequestId)}));
  case 'talent-attendance':check(p,[]);talent();return require('./talent-attendance').publicStatus(await call('get_talent_attendance_status'));
  case 'talent-time-off':check(p,[]);talent();return require('./talent-time-off').publicPayload(await call('get_talent_time_off'));
  case 'tasks':check(p,[]);talent();return require('./tasks').publicPayload(await call('get_applicant_task_workspace'));
  case 'task-detail':check(p,['taskId']);talent();return require('./task-detail').detail(await call('task_detail',{p_task_id:id(p.taskId),p_action:'get',p_expected_version:null,p_request_id:null,p_patch:{}}));
  case 'document-center':
   check(p,['view','q','status','offset','filesOffset','subjectKind','subjectId','requestId','fileId','origin','notifications']);
   if(p.fileId)return signed(await privateRead('document-file',{id:id(p.fileId),origin:p.origin||'center'}));
   if(p.requestId)return call('document_center_detail',{p_id:id(p.requestId)});
   if(p.notifications==='1')return call('document_center_notifications');
   return call('document_center_workspace',{p_query:p});
  case 'support-tickets':
   check(p,['ticketId','notifications','offset','status','team','assignment','view','reason','imageTicketId']);
   if(p.notifications==='1')return call('get_support_notifications');
   if(p.ticketId)return call('get_support_ticket',{p_ticket_id:id(p.ticketId)});
   if(p.imageTicketId){const f=await call('get_support_ticket_image',{p_ticket_id:id(p.imageTicketId)});if(!f?.storagePath||!/^organizations\/[a-f0-9-]+\/support\//i.test(f.storagePath)||f.storagePath.includes('..'))throw fail(404,'Image unavailable.');const r=await service('/storage/v1/object/sign/soro-support-images/'+f.storagePath.split('/').map(encodeURIComponent).join('/'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:60})});const v=await r.json();if(!r.ok)throw fail(503,'Image unavailable.');return{url:require('./document-center')._test.storageURL(v.signedURL,'sign')};}
   if(!/^\d{1,6}$/.test(p.offset||'0'))throw fail(400,'Invalid page.');
   return call('list_support_workspace',{p_offset:Number(p.offset||0),p_status:p.status||'',p_team:p.team||'',p_assignment:p.assignment||'',p_view:p.view||'all',p_reason:p.reason||''});
  case 'work-log':
   check(p,['placementId','from','to','offset','imageId']);
   if(p.imageId){const f=await call('get_work_screenshot',{p_id:id(p.imageId)}),h=require('./work-log')._test;const r=await service('/storage/v1/object/sign/'+h.path(f?.path),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expiresIn:60})});const v=await r.json();if(!r.ok)throw fail(503,'Image unavailable.');return{url:h.signedURL(v.signedURL),expiresIn:60};}
   return call('get_work_log',{p_filters:p});
  case 'portal-feedback':check(p,['offset']);if(!/^\d{1,6}$/.test(p.offset||'0'))throw fail(400,'Invalid page.');return call('list_portal_feedback',{p_offset:Number(p.offset||0)});
  case 'activity-history':{const q=require('./activity-history').queryFilters(p);return call('get_activity_history',{p_kind:q.kind,p_entity_id:q.id,p_filters:q.filters});}
  case 'talent-healthcare':check(p,['applicantId']);talent();if(p.applicantId!==c.applicantId)throw fail(403,'Choose this Talent profile.');return privateRead('healthcare');
  case 'dream-pathway':check(p,['applicantId']);talent();if(p.applicantId!==c.applicantId)throw fail(403,'Choose this Talent profile.');return rpc('get_dream_pathway',{p_actor_user_id:c.user.id,p_applicant_id:c.applicantId});
  case 'profile':check(p,[]);talent();{
   const value=(await rows(`applicants?id=eq.${c.applicantId}&organization_id=eq.${c.access.organization_id}&archived_at=is.null&portal_access_status=eq.active&select=${SELF_FIELDS},legacy_application_data&limit=1`))[0]||null;
   if(value)value.legacy_application_data=Object.fromEntries(['verified_skill_experience','soro_ops_skills','soro_ops_experience'].filter(k=>Object.hasOwn(value.legacy_application_data||{},k)).map(k=>[k,value.legacy_application_data[k]]));return value;
  }
  case 'profile-documents':check(p,[]);talent();return privateRead('profile-documents');
  case 'profile-file':check(p,['path']);talent();{const f=await privateRead('profile-file',{path:p.path});const v=await signed(f);return{signedUrl:v.url};}
  case 'profile-placements':check(p,[]);talent();return rows(`placements?applicant_id=eq.${c.applicantId}&organization_id=eq.${c.access.organization_id}&select=id,applicant_id,client_id,status,start_date,end_date,schedule_summary,rate_type,clients(id,company_name,industry,lifecycle_stage)&order=start_date.desc.nullslast&limit=100`);
  case 'profile-attendance':check(p,[]);talent();return rows(`talent_attendance_sessions?applicant_id=eq.${c.applicantId}&organization_id=eq.${c.access.organization_id}&select=applicant_id,work_date,work_timezone,started_at,checked_out_at,placement_id&order=started_at.desc&limit=60`);
  default:throw fail(403,'This action is not available in Read-Only Live View. Use your Admin Panel to make changes.');
 }
}
async function handler(event){
 if(event.httpMethod!=='GET')return json(405,{message:'Live portal observation is read-only.'});
 try{
  const q=event.queryStringParameters||{};
  if(event.body||event.isBase64Encoded||!exact(q,['action','portal','subject','resource','params'])||!['accounts','context','read'].includes(q.action)||!['client','va'].includes(q.portal)||Object.values(event.multiValueQueryStringParameters||{}).some(v=>v.length!==1))throw fail(400,'Unsupported live portal request.');
  const a=await founder(event);
  if(q.action==='accounts'){if(q.subject||q.resource||q.params)throw fail(400,'Unsupported account filter.');return json(200,{accounts:await accounts(a,q.portal)});}
  const c=await context(a,q.portal,q.subject);
  if(q.action==='context')return json(200,{actorId:a.id,subject:c.subject,readOnly:true});
  if(!q.resource||String(q.params||'').length>10000)throw fail(400,'Unsupported live portal request.');
  let p;try{p=JSON.parse(q.params||'{}');}catch{throw fail(400,'Invalid live portal parameters.');}
  return json(200,{actorId:a.id,subjectId:c.user.id,readOnly:true,data:await read(c,q.resource,p)});
 }catch(e){return json(e.status||503,{message:e.status?e.message:'The live portal is temporarily unavailable.'});}
}
module.exports={handler,context,accounts,read,SELF_FIELDS};
