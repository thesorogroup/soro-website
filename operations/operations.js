const data={overview:{title:'Admin Panel',caption:'Here is what needs your attention.',metrics:[['Tasks needing attention','—','Loading your assigned tasks…',''],['Client pipeline','—','Open Clients for current records',''],['Active Talent today','—','Loading live attendance…',''],['Talent Review Queue','—','Loading live applications…','']],primary:'Priority work',items:[],emptyMessage:'Loading your assigned tasks…',secondary:'Soro at a glance',secondaryMessage:'Summary reporting has not been configured.'},tasks:{title:'My Tasks',caption:'Your active work, in priority order.',table:['Task','Related to','Due','Owner'],rows:[]},clients:{title:'Client Pipeline',caption:'Every client, lead, and next action in one place.',table:['Client','Stage','Next action','Owner'],rows:[]},vas:{title:'Talent Directory',caption:'Search, filter, and open a complete Talent profile from any row.',table:['Talent','Application status','Work status','Location & time zone','Readiness','Owner'],rows:[]},placements:{title:'Placement Journey',caption:'Client and Talent readiness, side by side.',table:['Client','Talent','Status','Next action'],rows:[]},documents:{title:'Document Center',caption:'Assigned forms, uploads, and signed agreements.',table:['Document','Related to','Status','Action'],rows:[]},reports:{title:'Reports',caption:'Saved reports and quick builds, only for data you are authorized to see.',table:['Report','Last run','Owner','Action'],rows:[]}};
let current='overview',role='admin',liveApplicants=[],selectedTalentId=null,selectedClientId=null,preferredHiringRequestId='',preferredClientTalentId='',talentSearch='',talentStatus='all',ownTalentProfile=null,ownTalentProfileState='idle',ownTalentProfileRequest=0,liveApplicantsRequest=0,liveApplicantsScope='';
const roleConfig={admin:{label:'The Founder',person:'Matt',className:'role-admin'},sales:{label:'Sales Associate',person:'Sales workspace',className:'role-sales'},talent:{label:'Talent Management',person:'Talent Management workspace',className:'role-talent'},client:{label:'Client Administrator',person:'Client workspace',className:'role-client'},va:{label:'Talent',person:'Talent workspace',className:'role-va'}};
const roleDashboards={sales:{title:'Sales Panel',caption:'Your priority client work is ready.',metrics:[['Tasks needing attention','—','Loading your assigned tasks…',''],['My client pipeline','—','Not configured',''],['Open hiring requests','—','Not configured',''],['My available Talent','—','Not configured','']],primary:'Priority work',items:[],emptyMessage:'Loading your assigned tasks…',secondary:'Pipeline movement',secondaryMessage:'No live summary is available for this view.'},talent:{title:'Talent Management Panel',caption:'Your Talent readiness and support work is ready.',metrics:[['Talent actions needing attention','—','Loading your assigned tasks…',''],['Active Talent today','—','Loading live attendance…',''],['Talent Review Queue','—','Loading live applications…',''],['Upcoming reviews','—','Not configured','']],primary:'Priority work',items:[],emptyMessage:'Loading your assigned tasks…',secondary:'Talent readiness',secondaryMessage:'No live summary is available for this view.'},client:{title:'Client Portal',caption:'Your active Talent support and Soro actions are all in one place.',metrics:[['Action needed','—','Not configured',''],['Your current Talent','—','Not configured',''],['Open hiring requests','—','Not configured',''],['Invoices','—','Not configured','']],primary:'Action needed',items:[],emptyMessage:'No actions are assigned right now.',secondary:'Your current Talent',secondaryMessage:'No live summary is available for this view.'},va:{title:'Talent Portal',caption:'Your workday, progress, and support are all here.',metrics:[['Today’s work','—','Current placement status will appear here',''],['Dream Pathway','—','Not configured',''],['Next payout','—','Not configured',''],['Documents','—','Not configured','']],primary:'Action needed',items:[],emptyMessage:'No actions are assigned right now.',secondary:'Your progress',secondaryMessage:'No live summary is available for this view.'}};
const root=document.getElementById('view-root'),nav=document.getElementById('main-nav');
const authenticatedEmployeeViews=Object.freeze({
  admin:new Set(['overview','tasks','clients','client-shortlists','client-placement','vas','available-talent','talent-review','talent-profile','placements','documents','reports','activity','employees','payroll','help']),
  talent_management:new Set(['overview','tasks','clients','client-placement','vas','available-talent','talent-review','talent-profile','placements','documents','reports','talent-payout-review','help']),
  sales:new Set(['documents','overview','tasks','clients','client-shortlists','client-placement','available-talent','talent-profile','placements','reports','help']),
  sales_management:new Set(['documents','overview','tasks','clients','client-shortlists','client-placement','available-talent','talent-profile','placements','reports','help']),
  billing:new Set(['overview','tasks','placements','documents','reports','help']),
  client_admin:new Set(['documents','overview','client-candidate-review','client-placement','client-talent-profile','my-profile','help']),
  client_reviewer:new Set(['documents','overview','client-candidate-review','client-placement','client-talent-profile','my-profile','help']),
  client_billing:new Set(['documents','overview','my-profile','help']),
  virtual_assistant:new Set(['overview','talent-my-profile','documents','help'])
});
// Feedback is available to every established portal role, without widening any other access.
Object.values(authenticatedEmployeeViews).forEach(views=>views.add('feedback'));
['admin','talent_management','client_admin','client_reviewer','virtual_assistant'].forEach(r=>authenticatedEmployeeViews[r].add('work-log'));
const workspacePreviewAccessRole=Object.freeze({admin:'admin',sales:'sales',talent:'talent_management',client:'client_admin',va:'virtual_assistant'});
function actualAuthenticatedRole(access=window.soroCurrentAccess){return String(access?.role||'').toLowerCase()}
function effectiveWorkspaceRole(access=window.soroCurrentAccess){const actualRole=actualAuthenticatedRole(access);return actualRole==='admin'?(workspacePreviewAccessRole[role]||'admin'):actualRole}
function isAdminWorkspacePreview(workspace=role){return actualAuthenticatedRole()==='admin'&&role===workspace&&workspace!=='admin'}
function currentAuthenticatedRole(){return effectiveWorkspaceRole()}
const authenticatedClientRoles=new Set(['client_admin','client_reviewer','client_billing']);
const clientSafeViewData=Object.freeze({
  overview:{title:'Client Portal',caption:'Your Soro account, assigned work, and service updates are all in one place.',metrics:[['Action needed','—','No assigned actions yet',''],['Current Talent','—','Placement details will appear here',''],['Hiring requests','—','Request updates will appear here',''],['Documents','—','Assigned documents will appear here','']],primary:'Your Soro account',items:[],emptyMessage:'Assigned actions and updates from your Soro team will appear here.',secondary:'Account activity',secondaryMessage:'Your recent client-portal activity will appear here as services are connected.'},
  tasks:{title:'My Tasks',caption:'Tasks assigned to your client account.',table:['Task','Related to','Due','Status'],rows:[]},
  placements:{title:'Your Talent',caption:'Placement updates shared with your client account.',table:['Talent','Role','Status','Next step'],rows:[]},
  documents:{title:'Documents',caption:'Documents securely shared with your client account.',table:['Document','Related to','Status','Action'],rows:[]},
  reports:{title:'Reports',caption:'Reports available to your client account.',table:['Report','Period','Status','Action'],rows:[]}
});
const talentSafeViewData=Object.freeze({
  tasks:{title:'My Tasks',caption:'Tasks assigned to your Talent account.',table:['Task','Related to','Due','Status'],rows:[]},
  documents:{title:'My Documents',caption:'Documents securely shared with your Talent account.',table:['Document','Related to','Status','Action'],rows:[]}
});
const clientWorkspacePreviewProfile=Object.freeze({contact:{},company:{},permissions:{},signInEmail:''});
const clientWorkspacePreviewTalent=Object.freeze({talents:[]});
const talentWorkspacePreviewProfile=null;
const lifecyclePreviewIds=Object.freeze({
  request:'10000000-0000-4000-8000-000000000001',client:'10000000-0000-4000-8000-000000000002',shortlist:'33333333-3333-4333-8333-333333333333',
  shortlistItem:'44444444-4444-4444-8444-444444444444',addedItem:'55555555-5555-4555-8555-555555555555',shortlistedTalent:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',benchTalent:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',salesOwner:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
});
function cloneApprovalData(value){return JSON.parse(JSON.stringify(value))}
function shortlistApprovalSeed(viewerRole){return{generatedAt:new Date().toISOString(),viewerRole,hiringRequests:[],candidates:[],notifications:[]};}
function createShortlistApprovalAdapter(viewerRole,mode){
  let workspace=shortlistApprovalSeed(viewerRole,mode);
  const loader=async()=>cloneApprovalData(workspace);
  const submitter=async body=>{
    const action=String(body?.action||'').toLowerCase(),timestamp=new Date().toISOString();
    const request=workspace.hiringRequests[0],shortlist=request.shortlist;
    if(action==='respond_candidate'){
      shortlist.items=shortlist.items.map(item=>item.shortlistItemId===body.shortlistItemId?{...item,response:String(body.response||''),responseAt:timestamp,canRespond:false,updatedAt:timestamp}:item);
    }else if(action==='remove_candidate'){
      shortlist.items=shortlist.items.filter(item=>item.shortlistItemId!==body.shortlistItemId);
    }else if(action==='send_shortlist'){
      shortlist.status='client_review';shortlist.sentAt=timestamp;shortlist.canSend=false;
    }else if(action==='add_candidate'&&!shortlist.items.some(item=>item.applicantId===body.applicantId)){
      const candidate=workspace.candidates.find(item=>item.applicantId===body.applicantId);
      if(candidate)shortlist.items.push({shortlistItemId:lifecyclePreviewIds.addedItem,applicantId:candidate.applicantId,fullName:candidate.displayName,preferredName:'Mariel',verifiedSkills:candidate.verifiedSkills,availability:candidate.availability,experienceYears:candidate.yearsExperience,clientVisible:true,canRemove:true,canRespond:false,response:'',addedAt:timestamp,updatedAt:timestamp});
    }
    shortlist.updatedAt=timestamp;workspace={...workspace,generatedAt:timestamp};
    return{workspace:cloneApprovalData(workspace)};
  };
  const passAdapter={kind:'approval',mutate:async(action,values,verify)=>{
    if(viewerRole!=='client_admin'||action!=='final_decision'||values.decision!=='passed')throw new Error('This action is unavailable in this review.');
    const request=workspace.hiringRequests[0],item=request.shortlist.items.find(row=>row.shortlistItemId===values.shortlistItemId);
    if(!item||item.response||item.updatedAt!==values.expectedUpdatedAt)throw new Error('Refresh this candidate before recording a decision.');
    request.shortlist.items=request.shortlist.items.filter(row=>row!==item);
    const result=window.SoroClientPlacementWorkflow.defaultSeed('client_admin');
    result.request.hiringRequestId=request.id;result.request.companyName=request.clientName;result.request.title=request.roleTitle;
    result.candidates=[];result.handoffs=[];result.placements=[];
    return verify?verify(result):result;
  }};
  return Object.freeze({kind:'approval',loader,submitter,passAdapter});
}
function availableTalentApprovalSeed(viewerRole){return{generatedAt:new Date().toISOString(),viewerRole,caseload:{claimed:0,capacity:0,remaining:0},salesOwners:[],filters:{vaTypes:[],verifiedSkills:[],availabilityOptions:[]},items:[]};}
function createAvailableTalentApprovalAdapter(viewerRole){
  let queue=availableTalentApprovalSeed(viewerRole);
  const loader=async()=>cloneApprovalData(queue);
  const submitter=async body=>{
    const action=String(body?.action||'').toLowerCase(),timestamp=new Date().toISOString();
    if(action==='set_limit'){
      queue={...queue,salesOwners:queue.salesOwners.map(owner=>owner.id===body.salesOwnerId?{...owner,capacity:Number(body.caseloadLimit)||owner.capacity}:owner)};
    }else if(['claim','assign','reassign','release'].includes(action)){
      queue={...queue,items:queue.items.map(item=>item.applicantId!==body.applicantId?item:{...item,owner:action==='release'?{id:'',name:'Unassigned'}:{id:body.salesOwnerId||lifecyclePreviewIds.salesOwner,name:'Morgan Lee'},updatedAt:timestamp,allowedActions:action==='release'?['claim']:viewerRole==='sales'?['release']:['reassign','release']})};
    }
    queue={...queue,generatedAt:timestamp};return cloneApprovalData(queue);
  };
  return Object.freeze({kind:'approval',loader,submitter});
}
function adminPreviewingNonAdminWorkspace(){return actualAuthenticatedRole()==='admin'&&currentAuthenticatedRole()!=='admin'}
function salesTrackerPreviewWorkspace(){return{generatedAt:new Date().toISOString(),viewerRole:'sales',rows:[]};}
function openSalesTrackerAction(row){
  if(!row||!['sales','sales_management'].includes(currentAuthenticatedRole()))return;
  if(row.nextAction==='client_setup'){openSalesTrackerClient(row);return}
  const action=({find_candidates:'find_talent',review_shortlist:'shortlist',manage_interviews:'interview',
    review_selection:'selection',prepare_handoff:'placement',view_onboarding:'onboarding',view_placement:'placement'})[row.nextAction];
  if(action)window.dispatchEvent(new CustomEvent('soro:client-workflow-action',{detail:{action,requestId:row.requestId}}));
}
function openSalesTrackerClient(row){
  if(!['sales','sales_management'].includes(currentAuthenticatedRole())||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(row?.clientId||'')))return;
  current='clients';selectedClientId=row.clientId;selectedTalentId=null;
  history.pushState({clientHubId:row.clientId},'',`${location.pathname}#clients`);setActive();render();
}
function mountSalesTracker(){
  if(current!=='overview'||role!=='sales'||!['sales','sales_management'].includes(currentAuthenticatedRole()))return;
  const target=root.querySelector('#sales-lifecycle-tracker'),tracker=window.SoroSalesLifecycleTracker;
  if(!target||!tracker)return;
  const options={role:currentAuthenticatedRole(),onAction:openSalesTrackerAction,onOpenClient:openSalesTrackerClient,preserveFilters:true};
  if(adminPreviewingNonAdminWorkspace()){options.loader=async()=>salesTrackerPreviewWorkspace();options.preview=true}
  tracker.mount(target,options);
}
function salesOverview(d){
  const taskItems=d.items.length?list(d.items):`<p class="empty">${escapeHtml(d.emptyMessage||'No assigned tasks need attention.')}</p>`;
  return `${adminPreviewingNonAdminWorkspace()?'<p class="eyebrow">Sales workspace preview · no sample records</p>':''}<div id="sales-lifecycle-tracker"></div><div class="sales-dashboard-support">${metricCard(d.metrics[0],0)}<section class="panel"><div class="panel-head"><h2 id="detail-title">${d.primary}</h2><button class="text-button" id="view-all">View all tasks</button></div><div id="detail-list">${taskItems}</div></section></div>`;
}
function clientWorkflowMountOptions(accessRole){
  const options={role:accessRole};
  if(adminPreviewingNonAdminWorkspace()){
    const seed=window.SoroClientWorkflow.defaultSeed?.(accessRole)||[];
    if(seed[0])seed[0]={...seed[0],id:lifecyclePreviewIds.client};
    options.adapter=window.SoroClientWorkflow.createApprovalAdapter(seed);
  }
  return options;
}
function clientShortlistMountOptions(accessRole,mode,requestId=''){
  const options={role:accessRole,mode,requestId};
  if(adminPreviewingNonAdminWorkspace()){const adapter=createShortlistApprovalAdapter(accessRole,mode);options.loader=adapter.loader;options.submitter=adapter.submitter;options.passAdapter=adapter.passAdapter}
  return options;
}
function availableTalentMountOptions(accessRole){
  const options={role:accessRole,preferredRequestId:preferredHiringRequestId};
  if(adminPreviewingNonAdminWorkspace()){
    const adapter=createAvailableTalentApprovalAdapter(accessRole);options.loader=adapter.loader;options.submitter=adapter.submitter;
    if(accessRole==='sales'){const shortlist=createShortlistApprovalAdapter('sales','sales');options.shortlistLoader=shortlist.loader;options.shortlistSubmitter=shortlist.submitter}
  }
  return options;
}
const talentProfileSelectFields='id,organization_id,auth_user_id,full_name,preferred_name,birth_date,gender_identity,gender_identity_self_description,pronouns,pronouns_self_description,email,phone,location,country,address_line_1,address_line_2,city,province_region,postal_code,timezone,timezone_other_detail,status,status_reason,work_status,work_status_other_detail,availability_note,expected_hourly_rate,expected_hourly_rate_max,expected_hourly_rate_text,education_level,greatest_dream,referral_source,dedicated_workspace,has_laptop,has_noise_canceling_headset,has_reliable_internet,has_backup_internet,has_emergency_workspace,equipment_summary,internet_summary,english_proficiency,assessment_summary,english_test_result,personality_profile_score,computer_specs,internet_speed,loom_video_url,resume_url,application_received_at,submitted_at,created_at,updated_at,verified_skills,self_reported_experience_areas,self_reported_skills,other_experience_specialty,relevant_experience_years,relevant_experience_summary,education_training_summary,skill_profile_updated_at,talent_review_owner_id,sales_owner_id,talent_support_owner_id,legacy_application_data';
const talentSelfProfileSelectFields='id,organization_id,auth_user_id,full_name,preferred_name,birth_date,gender_identity,gender_identity_self_description,pronouns,pronouns_self_description,email,phone,location,country,address_line_1,address_line_2,city,province_region,postal_code,timezone,timezone_other_detail,status,work_status,work_status_other_detail,availability_note,expected_hourly_rate,expected_hourly_rate_max,expected_hourly_rate_text,greatest_dream,dedicated_workspace,has_laptop,equipment_summary,internet_summary,english_test_result,personality_profile_score,computer_specs,internet_speed,application_received_at,submitted_at,verified_skills,self_reported_experience_areas,self_reported_skills,other_experience_specialty,relevant_experience_years,relevant_experience_summary,education_training_summary,skill_profile_updated_at,legacy_application_data';
function isTalentSelfProfileView(){return current==='talent-my-profile'}
function currentTalentProfileApplicant(){
  if(isTalentSelfProfileView())return isAdminWorkspacePreview('va')?talentWorkspacePreviewProfile:ownTalentProfile;
  return liveApplicants.find(applicant=>String(applicant.id)===String(selectedTalentId))||null;
}
window.soroCurrentTalentProfileApplicant=currentTalentProfileApplicant;
function clientDashboardPreviewWorkspace(){return{generatedAt:new Date().toISOString(),viewerRole:'client_admin',companyName:'',contactName:'',requests:[],interviews:[],talent:[]};}
function openClientDashboardAction(action,id=''){
  if(!authenticatedClientRoles.has(currentAuthenticatedRole()))return;
  if(action==='work-log'&&viewAllowedForAuthenticatedRole('work-log')){history.replaceState({...history.state,workLogPlacement:id},'',location.href);current='work-log';history.pushState({workLogPlacement:id},'',`${location.pathname}#work-log`);render();setActive();return}
  if(action==='account'){goToMyProfile();return}
  if(action==='help'){current='help';history.pushState({},'',`${location.pathname}#help`);render();setActive();return}
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))return;
  if(action==='progress'){openClientPlacementWorkflow(id);return}
  if(action==='review'&&viewAllowedForAuthenticatedRole('client-candidate-review')){
    preferredHiringRequestId=id;current='client-candidate-review';
    history.pushState({},'',`${location.pathname}#client-candidate-review`);render();setActive();
  }
  if(action==='talent'&&viewAllowedForAuthenticatedRole('client-talent-profile')){
    preferredClientTalentId=id;goToClientTalentProfile();
  }
}
function renderClientAccountWorkspacePreview(){
  const preview=window.SORO_CLIENT_PROFILE_PREVIEW;
  if(!preview?.renderProfile){root.replaceChildren();return}
  root.innerHTML=preview.renderProfile(clientWorkspacePreviewProfile,'client_admin');
  root.querySelector('#client-profile-form')?.addEventListener('submit',event=>{event.preventDefault();toast('This is a preview. Client account changes are saved only from the signed-in Client Portal.')});
}
function renderClientTalentWorkspacePreview(){
  const preview=window.SORO_CLIENT_TALENT_PROFILE_PREVIEW;
  if(!preview?.renderProfile){root.replaceChildren();return}
  root.innerHTML=preview.renderProfile(clientWorkspacePreviewTalent,'preview-talent');
  preview.refreshVisuals?.(root);
}
function talentSelfProfileStatusMarkup(){
  const message=ownTalentProfileState==='loading'
    ? 'Loading your secure Talent profile…'
    : ownTalentProfileState==='error'
      ? 'Your Talent profile could not be loaded securely. Refresh the page or contact Talent Management.'
      : 'Your portal account is active, but it is not linked to a Talent profile yet. Contact Talent Management for help.';
  return `<main class="page talent-self-profile-state"><section class="panel profile-missing"><p class="eyebrow">Talent Portal</p><h1>My Profile</h1><p>${escapeHtml(message)}</p></section></main>`;
}
function viewAllowedForAuthenticatedRole(view){
  const accessRole=currentAuthenticatedRole();
  const allowed=authenticatedEmployeeViews[accessRole];
  if(view==='client-record')return Boolean(allowed?.has('clients'));
  return Boolean(allowed?.has(view));
}
function dataAllowedForAuthenticatedRole(view,viewData){
  const accessRole=currentAuthenticatedRole();
  if(view!=='reports'||!viewData?.rows)return viewData;
  const allowedReports={
    sales:new Set(['Sales Pipeline Health','Client Feedback Trends']),
    talent_management:new Set(['Active Talent Attendance','Client Feedback Trends'])
  }[accessRole];
  return allowedReports?{...viewData,rows:viewData.rows.filter(row=>allowedReports.has(row[0]))}:viewData;
}
function viewDataForAuthenticatedRole(view,viewData){
  const accessRole=currentAuthenticatedRole();
  if(authenticatedClientRoles.has(accessRole))return clientSafeViewData[view]||viewData;
  if(actualAuthenticatedRole()==='virtual_assistant')return talentSafeViewData[view]||viewData;
  if(accessRole==='virtual_assistant')return talentSafeViewData[view]||viewData;
  return dataAllowedForAuthenticatedRole(view,viewData);
}
function syncAuthorizedNavigation(access=window.soroCurrentAccess){
  const accessRole=effectiveWorkspaceRole(access);
  window.soroPageTaskAction?.sync();
  const allowed=authenticatedEmployeeViews[accessRole]||new Set();
  const clientPortal=authenticatedClientRoles.has(accessRole);
  document.querySelectorAll('#main-nav [data-view]').forEach(button=>{
    button.hidden=!allowed.has(button.dataset.view);
  });
  const supportNav=document.getElementById('support-tickets-nav');
  // Auth events carry the access row; the verified session identity lives on soroCurrentAccess.
  if(supportNav)supportNav.hidden=!access||!(access.user_id||window.soroCurrentAccess?.user_id)||access.active===false||access.must_change_password===true||!window.SoroSupportTickets?.canReviewRole?.(accessRole);
  const actualRole=actualAuthenticatedRole(access);
  const payrollNav=document.getElementById('payroll-nav');
  const talentPayoutReviewNav=document.getElementById('talent-payout-review-nav');
  if(payrollNav)payrollNav.hidden=actualRole!=='admin'||accessRole!=='admin';
  if(talentPayoutReviewNav)talentPayoutReviewNav.hidden=actualRole!=='talent_management'||accessRole!=='talent_management';
  document.querySelectorAll('[data-notification-view]').forEach(button=>{
    button.hidden=!['help','documents'].includes(button.dataset.notificationView)&&(clientPortal||!allowed.has(button.dataset.notificationView));
  });
  const notificationsButton=document.getElementById('notifications-button');
  if(notificationsButton)notificationsButton.hidden=!actualRole;
  const globalSearch=document.getElementById('global-search')?.closest('.global-search');
  if(globalSearch)globalSearch.hidden=clientPortal||accessRole==='virtual_assistant'||(actualRole==='admin'&&accessRole!=='admin');
  const overviewNav=document.getElementById('overview-nav');
  if(overviewNav)overviewNav.textContent=clientPortal||accessRole==='virtual_assistant'?'Dashboard':'Overview';
  if(!allowed.has(current==='client-record'?'clients':current)){
    current='overview';selectedTalentId=null;selectedClientId=null;
    history.replaceState({},'',`${location.pathname}#overview`);
  }
  setActive();
}
window.soroSyncAuthorizedNavigation=syncAuthorizedNavigation;
const documentLabels={resume:'Résumé',english_proof:'English test / proof',disc_assessment:'DISC assessment',enneagram_assessment:'Enneagram test',mbti_assessment:'MBTI-style assessment',internet_proof:'Internet-speed proof',equipment_proof:'Equipment proof',assessment:'Assessment',introduction_video:'Introduction video',profile_photo:'Profile headshot',application_attachment:'Application attachment'};
function toast(message){const t=document.createElement('div');t.className='toast';t.textContent=message;document.body.append(t);setTimeout(()=>t.remove(),3600)}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}function titleCase(value){return String(value||'Not yet recorded').replaceAll('_',' ').replace(/\b\w/g,l=>l.toUpperCase())}function initials(name){return String(name||'Talent').split(/\s+/).filter(Boolean).slice(0,2).map(p=>p[0]).join('').toUpperCase()}
function normalizeTalentUtcOffset(value){
  const raw=String(value||'').trim();
  if(/^(?:GMT|UTC)$/i.test(raw))return'UTC+00:00';
  const match=raw.match(/(?:GMT|UTC)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?/i);
  if(!match)return'';
  const sign=match[1]==='-'||match[1]==='−'?'−':'+';
  return`UTC${sign}${String(Math.min(23,Number(match[2]))).padStart(2,'0')}:${String(Math.min(59,Number(match[3]||0))).padStart(2,'0')}`;
}
function talentTimeZoneOffset(timeZone,date){
  try{
    const offsetName=new Intl.DateTimeFormat('en-US',{timeZone,timeZoneName:'longOffset'}).formatToParts(date).find(part=>part.type==='timeZoneName')?.value;
    const normalized=normalizeTalentUtcOffset(offsetName);
    if(normalized)return normalized;
  }catch{}
  try{
    const parts=new Intl.DateTimeFormat('en-US',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
    const values=Object.fromEntries(parts.filter(part=>part.type!=='literal').map(part=>[part.type,part.value]));
    const localAsUtc=Date.UTC(Number(values.year),Number(values.month)-1,Number(values.day),Number(values.hour),Number(values.minute),Number(values.second));
    const minutes=Math.round((localAsUtc-date.getTime())/60000);
    const sign=minutes<0?'−':'+';
    const absolute=Math.abs(minutes);
    return`UTC${sign}${String(Math.floor(absolute/60)).padStart(2,'0')}:${String(absolute%60).padStart(2,'0')}`;
  }catch{return''}
}
function formatTalentTimeZone(value,date=new Date()){
  const raw=String(value||'').trim();
  if(!raw)return'';
  try{
    const canonical=new Intl.DateTimeFormat('en-US',{timeZone:raw}).resolvedOptions().timeZone||raw;
    let friendly=new Intl.DateTimeFormat('en-US',{timeZone:canonical,timeZoneName:'longGeneric'}).formatToParts(date).find(part=>part.type==='timeZoneName')?.value||'';
    if(!friendly||/^(?:GMT|UTC)(?:[+\-−]|$)/i.test(friendly)){
      const knownNames={'America/New_York':'Eastern Time','America/Chicago':'Central Time','America/Denver':'Mountain Time','America/Los_Angeles':'Pacific Time','America/Anchorage':'Alaska Time','Pacific/Honolulu':'Hawaii Time','Asia/Manila':'Philippine Time'};
      friendly=knownNames[canonical]||`${canonical.split('/').pop().replaceAll('_',' ')} Time`;
    }
    const offset=talentTimeZoneOffset(canonical,date);
    return`${friendly}${offset?` · ${offset}`:''} (${canonical})`;
  }catch{
    return normalizeTalentUtcOffset(raw)||raw;
  }
}
function formatTalentLocationTimeZone(locationValue,timeZoneValue,date=new Date()){
  return[String(locationValue||'').trim(),formatTalentTimeZone(timeZoneValue,date)].filter(Boolean).join(' · ')||'Not recorded';
}
function recordedTalentTimeZone(record){
  const selected=String(record?.timezone||'').trim();
  return selected.toLowerCase()==='other'&&String(record?.timezone_other_detail||'').trim()
    ? String(record.timezone_other_detail).trim()
    : selected;
}
window.formatTalentTimeZone=formatTalentTimeZone;
window.formatTalentLocationTimeZone=formatTalentLocationTimeZone;
window.recordedTalentTimeZone=recordedTalentTimeZone;
function metricCard(m,i){return `<button class="metric ${m[3]}" data-metric="${i}"><p>${m[0]}</p><strong>${m[1]}</strong><small>${m[2]}</small></button>`}function list(items){return `<div class="list">${items.map(x=>`<div class="list-item"><span class="status-dot ${x[0]}"></span><span><strong>${x[1]}</strong><small>${x[2]}</small></span><span class="pill">${x[3]}</span></div>`).join('')}</div>`}function chart(){return '<p class="empty">No live trend data is available yet.</p>'}
function readinessSummary(a){const x=[];if(a.resume_url)x.push('Résumé');if(a.english_proficiency)x.push('English');if(a.equipment_summary)x.push('Equipment');return x.length?x.slice(0,2).join(' · '):'Profile review'}
function talentDirectory(){const query=talentSearch.trim().toLowerCase();const applicants=liveApplicants.filter(a=>{const matches=!query||[a.full_name,a.email,a.phone,a.location,a.timezone,a.status,a.work_status].filter(Boolean).join(' ').toLowerCase().includes(query);return matches&&(talentStatus==='all'||a.status===talentStatus)});const statuses=[...new Set(liveApplicants.map(a=>a.status).filter(Boolean))];const rows=applicants.length?applicants.map(a=>`<tr class="talent-row" data-talent-id="${escapeHtml(a.id)}" tabindex="0" role="link" aria-label="Open ${escapeHtml(a.full_name)} profile"><td><div class="talent-cell"><span class="mini-avatar">${escapeHtml(initials(a.full_name))}</span><span><strong>${escapeHtml(a.full_name)}</strong><small>${escapeHtml(a.email||'No email recorded')}</small></span></div></td><td><span class="tag">${escapeHtml(titleCase(a.status))}</span></td><td>${escapeHtml(titleCase(a.work_status))}</td><td>${escapeHtml(formatTalentLocationTimeZone(a.location,recordedTalentTimeZone(a)))}</td><td>${escapeHtml(readinessSummary(a))}</td><td>${a.talent_review_owner_id?'Assigned':'Unassigned'}</td></tr>`).join(''):`<tr><td class="empty" colspan="6">No Talent profiles match those filters.</td></tr>`;return `<div class="directory-toolbar panel"><label class="directory-search"><span>⌕</span><input id="talent-search" type="search" value="${escapeHtml(talentSearch)}" placeholder="Search Talent by name, email, location, skill, or status" /></label><label class="directory-filter">Status<select id="talent-status-filter"><option value="all">All statuses</option>${statuses.map(s=>`<option value="${escapeHtml(s)}" ${s===talentStatus?'selected':''}>${escapeHtml(titleCase(s))}</option>`).join('')}</select></label><span class="directory-count">${applicants.length} of ${liveApplicants.length} profiles</span></div><div class="panel table-wrap"><table class="data-table talent-directory-table"><thead><tr>${data.vas.table.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`}
function table(d){const body=d.rows.length?d.rows.map(r=>`<tr>${r.map((x,i)=>`<td>${i===1&&current==='clients'?`<span class="tag">${escapeHtml(x)}</span>`:escapeHtml(x)}</td>`).join('')}</tr>`).join(''):`<tr><td class="empty" colspan="${d.table.length}">No authorized records are available yet.</td></tr>`;return `<div class="panel table-wrap"><table class="data-table"><thead><tr>${d.table.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`}function overview(d){const clientPortal=authenticatedClientRoles.has(currentAuthenticatedRole()),primaryContent=d.items.length?list(d.items):`<p class="empty">${escapeHtml(d.emptyMessage||'No authorized records are available yet.')}</p>`,secondaryContent=d.secondaryMessage?`<p class="empty">${escapeHtml(d.secondaryMessage)}</p>`:`${chart()}<p class="eyebrow" style="margin-top:28px">Active placements this week</p>`;return `<div class="card-grid">${d.metrics.map(metricCard).join('')}</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h2 id="detail-title">${d.primary}</h2>${clientPortal?'':'<button class="text-button" id="view-all">View all</button>'}</div><div id="detail-list">${primaryContent}</div></section><section class="panel"><div class="panel-head"><h2>${d.secondary}</h2>${d.secondaryMessage?'':'<button class="text-button">Open report</button>'}</div>${secondaryContent}</section></div>`}
function profilePage(a){if(!a)return `<main class="page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="panel profile-missing"><h1>Talent profile not found</h1><p>This profile may have been removed or you may no longer have access.</p></section></main>`;const contact=[a.email,a.phone].filter(Boolean).join(' · ')||'Contact information not recorded';return `<main class="page talent-profile-page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="talent-profile-hero"><div class="headshot-wrap"><div class="talent-headshot" id="talent-headshot"><span>${escapeHtml(initials(a.full_name))}</span></div><label class="button headshot-upload">Upload headshot<input type="file" id="headshot-input" accept="image/jpeg,image/png,image/webp" hidden /></label><small>JPG, PNG, or WebP · up to 5 MB</small></div><div class="profile-identity"><p class="eyebrow">Talent profile</p><h1>${escapeHtml(a.full_name)}</h1><p>${escapeHtml(contact)}</p><div class="profile-tags"><span class="tag">${escapeHtml(titleCase(a.status))}</span><span class="tag neutral">${escapeHtml(titleCase(a.work_status))}</span></div></div><div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div></section><section class="profile-stat-grid"><article><p>Location & time zone</p><strong>${escapeHtml(formatTalentLocationTimeZone(a.location,recordedTalentTimeZone(a)))}</strong></article><article><p>Availability</p><strong>${escapeHtml(a.availability_note||a.dedicated_workspace||'Availability to review')}</strong></article><article><p>Application received</p><strong>${a.application_received_at?escapeHtml(new Date(a.application_received_at).toLocaleDateString()):'Not recorded'}</strong></article><article><p>Profile owner</p><strong>${a.talent_review_owner_id?'Assigned':'Unassigned'}</strong></article></section><div class="profile-layout"><section class="panel profile-section"><div class="panel-head"><div><p class="eyebrow">At a glance</p><h2>Profile details</h2></div></div><dl class="profile-details"><div><dt>Work status</dt><dd>${escapeHtml(titleCase(a.work_status))}</dd></div><div><dt>Expected rate</dt><dd>${escapeHtml(a.expected_hourly_rate_text||a.expected_hourly_rate||'Not recorded')}</dd></div><div><dt>English</dt><dd>${escapeHtml(a.english_proficiency||'Not recorded')}</dd></div><div><dt>Equipment</dt><dd>${escapeHtml(a.equipment_summary||'Not recorded')}</dd></div><div><dt>Internet</dt><dd>${escapeHtml(a.internet_summary||'Not recorded')}</dd></div><div><dt>Dream / goal</dt><dd>${escapeHtml(a.greatest_dream||'To be discussed in the Talent interview')}</dd></div></dl></section><section class="panel profile-section profile-documents-section"><div class="panel-head"><div><p class="eyebrow">Private files</p><h2>Documents & assessments</h2></div><button type="button" class="button" data-document-profile="talent" data-document-subject="${escapeHtml(a.id)}">Requests & saved documents</button></div><div id="profile-documents"><p class="eyebrow">Loading documents…</p></div></section></div></main>`}
function render(){
  window.SoroActivityHistory?.unmount?.();
  window.SoroWorkLog?.unmount?.();
  window.SoroPlacementEnding?.unmount?.();
  window.SoroReports?.unmount?.();
  window.SoroFeedback?.unmount?.();
  window.SoroDocumentCenter?.unmount?.();
  window.SoroSalesLifecycleTracker?.unmount?.({clear:false});
  window.SoroClientDashboard?.unmount?.({clear:false});
  if(!viewAllowedForAuthenticatedRole(current)){
    const allowed=authenticatedEmployeeViews[currentAuthenticatedRole()];
    if(!allowed?.has('overview')){root.replaceChildren();return}
    current='overview';selectedTalentId=null;selectedClientId=null;
    history.replaceState({},'',`${location.pathname}#overview`);
    setActive();
  }
  if(current!=='client-talent-profile')window.SoroClientTalentProfile?.unmount?.();
  if(current!=='client-record')window.SoroInternalClientProfile?.unmount?.();
  if(current!=='talent-profile')window.SoroReadOnlyTalentProfile?.reset?.();
  if(current!=='talent-review')window.soroTalentReviewQueue?.unmount?.();
  if(current!=='available-talent')window.soroAvailableTalentBench?.unmount?.({clear:false});
  if(!['client-shortlists','client-candidate-review'].includes(current))window.soroClientShortlistWorkflow?.unmount?.({clear:false});
  if(current!=='clients')window.SoroClientWorkflow?.unmount?.({clear:false});
  if(current!=='client-placement')window.SoroClientPlacementWorkflow?.unmount?.({clear:false});
  if(current==='placements'&&window.SoroPlacementEnding?.canManage(currentAuthenticatedRole())){
    window.SoroPlacementEnding.mount(root,{role:currentAuthenticatedRole(),preview:adminPreviewingNonAdminWorkspace(),placementId:history.state?.endingPlacementId,onOpenTalent:openTalentProfile});setActive();return;
  }
  if(current==='feedback'){
    window.SoroFeedback?.mount(root,{preview:adminPreviewingNonAdminWorkspace(),onSupport:()=>{current='help';history.pushState({},'',`${location.pathname}#help`);setActive();render();}});setActive();return;
  }
  if(current==='work-log'){
    window.SoroWorkLog?.mount(root,{role:currentAuthenticatedRole(),preview:adminPreviewingNonAdminWorkspace(),filters:history.state?.workLogPlacement?{placementId:history.state.workLogPlacement}:{}});setActive();return;
  }
  if(current==='reports'){
    window.SoroReports?.mount(root,{role:currentAuthenticatedRole(),preview:adminPreviewingNonAdminWorkspace()});setActive();return;
  }
  if(current==='activity'){
    root.innerHTML='<main class="page"><p><a class="ah-log-link" href="#reports">← Reports</a></p><div data-activity-log></div></main>';
    window.SoroActivityHistory?.mount(root.querySelector('[data-activity-log]'),{kind:'all',preview:adminPreviewingNonAdminWorkspace(),isCurrent:()=>current==='activity'});setActive();return;
  }
  if(current==='documents'){
    const params=new URLSearchParams(location.hash.split('?')[1]||'');
    const allowedKeys=['requestId','subjectKind','subjectId'];const opts={};
    allowedKeys.forEach(k=>{if(params.has(k))opts[k]=params.get(k)});
    if(adminPreviewingNonAdminWorkspace()){opts.personalOnly=true;delete opts.subjectKind;delete opts.subjectId;}
    window.SoroDocumentCenter?.mount(root,opts);setActive();return;
  }
  if(adminPreviewingNonAdminWorkspace()){
    root.innerHTML='<main class="page"><section class="panel"><h1>'+escapeHtml(roleConfig[role]?.label||'Workspace')+'</h1><p>Workspace navigation preview. Sample accounts and records have been removed. Sign in to an actual account to see its authorized records.</p><p>The Documents view shows your own real documents, not another person’s identity.</p></section></main>';
    setActive();return;
  }
  if(current==='client-record'){
    if(adminPreviewingNonAdminWorkspace()){
      const accessRole=currentAuthenticatedRole();
      if(!selectedClientId||!window.SoroClientWorkflow?.canOpenForRole?.(accessRole)){
        root.innerHTML='<main class="page"><button class="text-button back-to-clients">← Back to Clients</button><section class="panel profile-missing"><h1>Client profile unavailable</h1><p>This local workspace preview does not contain that Client.</p></section></main>';
        root.querySelector('.back-to-clients')?.addEventListener('click',goToClientDirectory);
      }else{
        const options=clientWorkflowMountOptions(accessRole);options.clientId=selectedClientId;
        window.SoroClientWorkflow.mount(root,options);
      }
      setActive();
      return;
    }
    if(!selectedClientId||!window.SoroInternalClientProfile?.load){
      root.innerHTML='<main class="page"><button class="text-button back-to-clients">← Back to Clients</button><section class="panel profile-missing"><h1>Client profile unavailable</h1><p>This profile could not be opened right now.</p></section></main>';
      root.querySelector('.back-to-clients')?.addEventListener('click',goToClientDirectory);
      setActive();
      return;
    }
    window.SoroInternalClientProfile.load(root,{id:selectedClientId,onBack:goToClientDirectory});
    setActive();
    return;
  }
  if(current==='my-profile'){
    if(isAdminWorkspacePreview('client')){
      renderClientAccountWorkspacePreview();
      setActive();
      return;
    }
    if(!authenticatedClientRoles.has(actualAuthenticatedRole())||!window.SoroClientProfile?.canOpenProfile()){
      root.replaceChildren();
      return;
    }
    window.SoroClientProfile.mount(root);
    setActive();
    return;
  }
  if(current==='client-talent-profile'){
    if(isAdminWorkspacePreview('client')){
      renderClientTalentWorkspacePreview();
      setActive();
      return;
    }
    if(!window.SoroClientTalentProfile?.canOpenTalentProfile()){
      root.replaceChildren();
      return;
    }
    window.SoroClientTalentProfile.mount(root,{talentId:preferredClientTalentId});
    setActive();
    return;
  }
  if(current==='talent-my-profile'){
    const applicant=currentTalentProfileApplicant();
    if(!applicant){root.innerHTML=talentSelfProfileStatusMarkup();setActive();return}
    selectedTalentId=applicant.id;
    root.innerHTML=profilePage(applicant);
    bindView();
    loadTalentProfileDocuments();
    setActive();
    return;
  }
  if(current==='overview'&&authenticatedClientRoles.has(currentAuthenticatedRole())){
    root.innerHTML='<div id="client-dashboard-root"></div>';
    const options={role:currentAuthenticatedRole(),onNavigate:openClientDashboardAction};
    if(isAdminWorkspacePreview('client')){options.loader=async()=>clientDashboardPreviewWorkspace();options.preview=true;}
    window.SoroClientDashboard?.mount(root.querySelector('#client-dashboard-root'),options);
    setActive();return;
  }
  if(current==='tasks'&&window.soroTaskCenter?.canLoad?.(actualAuthenticatedRole())){
    root.innerHTML=window.soroTaskCenter.renderPage();
    bindView();
    window.soroTaskCenter.bindPage(root);
    setActive();
    return;
  }
  if(current==='talent-review'){
    if(!window.soroTalentReviewQueue?.canOpenForRole?.(actualAuthenticatedRole())){root.replaceChildren();return}
    window.soroTalentReviewQueue.mount(root);
    setActive();
    return;
  }
  if(current==='available-talent'){
    const accessRole=currentAuthenticatedRole();
    if(!window.soroAvailableTalentBench?.canOpenForRole?.(accessRole)){root.replaceChildren();return}
    window.soroAvailableTalentBench.mount(root,availableTalentMountOptions(accessRole));
    setActive();
    return;
  }
  if(current==='client-shortlists'){
    const accessRole=currentAuthenticatedRole();
    if(!window.soroClientShortlistWorkflow?.canOpenForRole?.(accessRole,'sales')){root.replaceChildren();return}
    window.soroClientShortlistWorkflow.mount(root,clientShortlistMountOptions(accessRole,'sales',preferredHiringRequestId));
    setActive();
    return;
  }
  if(current==='client-candidate-review'){
    const accessRole=currentAuthenticatedRole();
    if(!window.soroClientShortlistWorkflow?.canOpenForRole?.(accessRole,'client')){root.replaceChildren();return}
    window.soroClientShortlistWorkflow.mount(root,clientShortlistMountOptions(accessRole,'client',preferredHiringRequestId));
    setActive();
    return;
  }
  if(current==='client-placement'){
    const accessRole=currentAuthenticatedRole();
    const placement=window.SoroClientPlacementWorkflow;
    if(!placement?.canOpenForRole?.(accessRole)||!preferredHiringRequestId){
      root.innerHTML='<main class="page"><section class="panel profile-missing" role="alert"><p class="eyebrow">Client placement</p><h1>Choose a hiring request first</h1><p>Open a Client hiring request or candidate review to continue its interview, selection, and placement workflow.</p></section></main>';
      setActive();
      return;
    }
    const previewingAnotherWorkspace=actualAuthenticatedRole()==='admin'&&accessRole!=='admin';
    const options={
      role:accessRole,
      hiringRequestId:preferredHiringRequestId,
      onChange:()=>window.dispatchEvent(new CustomEvent('soro:client-placement-updated',{detail:{requestId:preferredHiringRequestId}}))
    };
    if(!authenticatedClientRoles.has(accessRole))options.onOpenTalent=applicantId=>openTalentProfile(applicantId);
    if(previewingAnotherWorkspace)options.adapter=placement.createApprovalAdapter(placement.defaultSeed(accessRole));
    placement.mount(root,options);
    setActive();
    return;
  }
  if(current==='clients'&&window.SoroClientWorkflow?.canOpenForRole?.(currentAuthenticatedRole())){
    const accessRole=currentAuthenticatedRole();
    const options=clientWorkflowMountOptions(accessRole);
    if(selectedClientId||history.state?.clientHubId)options.clientId=selectedClientId||history.state.clientHubId;
    window.SoroClientWorkflow.mount(root,options);
    setActive();
    return;
  }
  if(current==='talent-profile'){
    const accessRole=currentAuthenticatedRole();
    if(adminPreviewingNonAdminWorkspace()){
      root.innerHTML='<main class="page talent-profile-page"><button class="text-button back-to-directory">← Back</button><section class="panel profile-missing" role="alert"><p class="eyebrow">Workspace preview</p><h1>Talent profile unavailable</h1><p>Live Talent profiles are not opened while previewing another role.</p></section></main>';
      bindView();
      setActive();
      return;
    }
    if(['sales','sales_management'].includes(accessRole)){
      if(window.SoroReadOnlyTalentProfile?.canOpenForRole?.(accessRole)){
        window.SoroReadOnlyTalentProfile.mount(root,{id:selectedTalentId,onBack:()=>window.soroGoBackFromReadOnlyTalentProfile?.()});
      }else{
        root.innerHTML='<main class="page talent-profile-page"><section class="panel profile-missing" role="alert"><p class="eyebrow">Talent profile</p><h1>Talent profile unavailable</h1><p>The secure read-only profile is still loading. Refresh and try again.</p></section></main>';
      }
      return;
    }
    root.innerHTML=profilePage(liveApplicants.find(a=>a.id===selectedTalentId));
    bindView();
    loadTalentProfileDocuments();
    return;
  }
  let baseData=current==='overview'?(role==='admin'?data.overview:roleDashboards[role]):data[current];
  if(current==='overview'&&role==='va'&&baseData?.metrics?.length&&window.soroTalentWorkday){
    baseData={...baseData,metrics:[window.soroTalentWorkday.dashboardMetric(baseData.metrics[0],actualAuthenticatedRole()),...baseData.metrics.slice(1)]};
  }
  if(current==='overview'&&baseData?.metrics?.length&&window.soroActiveTalentToday?.canLoadForRole(actualAuthenticatedRole())){
    baseData={...baseData,metrics:baseData.metrics.map(metric=>String(metric?.[0]||'').toLowerCase()==='active talent today'
      ? window.soroActiveTalentToday.dashboardMetric(metric,actualAuthenticatedRole())
      : metric)};
  }
  if(current==='overview'&&baseData?.metrics?.length&&window.soroTalentReviewQueue?.canOpenForRole?.(actualAuthenticatedRole())){
    baseData={...baseData,metrics:baseData.metrics.map(metric=>String(metric?.[0]||'').toLowerCase()==='talent review queue'
      ? window.soroTalentReviewQueue.dashboardMetric(metric,actualAuthenticatedRole())
      : metric)};
  }
  if(current==='overview'&&['admin','sales','talent'].includes(role)&&window.soroTaskCenter?.canLoad?.(actualAuthenticatedRole())){
    baseData=window.soroTaskCenter.dashboardData(baseData);
  }
  const d=viewDataForAuthenticatedRole(current,baseData);
  const newAction=role==='talent'?'New Talent':role==='client'?'Request Talent':'New Client';
  const primaryAction=role==='client'?'Request another Talent':'+ Add Task';
  const importAction=current==='vas'&&role==='admin'?`<button class="button" id="import-drive">Import Drive files</button>`:'';
  const clientPortal=authenticatedClientRoles.has(currentAuthenticatedRole());
  const talentWorkdayAction=role==='va'&&actualAuthenticatedRole()==='virtual_assistant'
    ? window.soroTalentWorkday?.actionMarkup({currentView:current,actualRole:actualAuthenticatedRole()})||''
    : '';
  const talentTimeOffAction=window.soroTalentTimeOff?.actionMarkup({currentView:current,actualRole:actualAuthenticatedRole()})||'';
  const managementTimeOffAction=role==='admin'||role==='talent'
    ? window.soroTalentTimeOff?.managementActionMarkup({currentView:current,actualRole:actualAuthenticatedRole()})||''
    : '';
  const canCreateClient=['admin','sales','sales_management'].includes(currentAuthenticatedRole());
  const showNewRecord=current==='overview'||(current==='clients'&&canCreateClient);
  const standardHeadingActions=`${managementTimeOffAction}<button class="button primary" id="add-task">${primaryAction}</button>${showNewRecord?`<button class="button" id="new-record">+ ${newAction}</button>`:''}${importAction}${role==='sales'?'':'<button class="button">Customize</button>'}`;
  const talentPortalActions=`${talentWorkdayAction}${talentTimeOffAction}${role==='va'&&current==='overview'?'<a class="button" href="#work-log">Work Log & screenshots</a>':''}`;
  const headingActions=clientPortal||role==='va'
    ? (talentPortalActions?`<div class="heading-actions">${talentPortalActions}</div>`:'')
    : `<div class="heading-actions">${standardHeadingActions}</div>`;
  root.innerHTML=`<main class="page"><div class="page-heading"><div><p class="eyebrow">${clientPortal?'Client Portal':'Soro Operations'}</p><h1>${d.title}</h1><p class="eyebrow" style="margin-top:9px">${d.caption}</p></div>${headingActions}</div>${current==='overview'?(role==='sales'?salesOverview(d):overview(d)):current==='vas'?talentDirectory():table(d)}</main>`;
  bindView();
  if(current==='overview'&&role==='sales')mountSalesTracker();
}
function bindView(){window.soroTalentWorkday?.bindDashboardAction(root);window.soroActiveTalentToday?.bindDashboardMetric(root,{currentView:current,actualRole:actualAuthenticatedRole()});window.soroTalentReviewQueue?.bindDashboardMetric?.(root,{currentView:current,actualRole:actualAuthenticatedRole()});window.soroTaskCenter?.bindDashboardMetric?.(root,current);window.soroTalentTimeOff?.bindDashboardActions(root,{currentView:current,actualRole:actualAuthenticatedRole()});document.getElementById('add-task')?.addEventListener('click',()=>{if(role==='client')toast('Your hiring request form is the next portal step.');else document.getElementById('task-dialog').showModal()});document.getElementById('new-record')?.addEventListener('click',()=>{if(window.SoroClientWorkflow?.canEditForRole?.(currentAuthenticatedRole())){const options=clientWorkflowMountOptions(currentAuthenticatedRole());options.start='create';current='clients';selectedClientId=null;selectedTalentId=null;history.pushState({},'',`${location.pathname}#clients`);setActive();window.SoroClientWorkflow.mount(root,options);return}toast(`${role==='talent'?'New Talent':role==='client'?'Request another Talent':'New Client'} form is the next build step.`)});document.getElementById('import-drive')?.addEventListener('click',importDriveFiles);document.getElementById('talent-search')?.addEventListener('input',e=>{talentSearch=e.target.value;render();document.getElementById('talent-search')?.focus()});document.getElementById('talent-status-filter')?.addEventListener('change',e=>{talentStatus=e.target.value;render()});document.querySelectorAll('.talent-row').forEach(row=>{const open=()=>openTalentProfile(row.dataset.talentId);row.addEventListener('click',open);row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}})});document.querySelectorAll('.back-to-directory').forEach(b=>b.addEventListener('click',goToTalentDirectory));document.getElementById('profile-add-task')?.addEventListener('click',()=>{const related=document.getElementById('task-related');if(related)related.value=currentTalentProfileApplicant()?.full_name||'';document.getElementById('task-dialog').showModal()});document.getElementById('headshot-input')?.addEventListener('change',e=>uploadHeadshot(e.target.files?.[0]));document.querySelectorAll('[data-metric]').forEach(el=>el.addEventListener('click',()=>{const dashboard=viewDataForAuthenticatedRole('overview',role==='admin'?data.overview:roleDashboards[role]),m=dashboard.metrics[+el.dataset.metric];document.getElementById('detail-title').textContent=m[0];document.getElementById('detail-list').innerHTML=`<p class="empty">${escapeHtml(m[2])}</p>`}));document.getElementById('view-all')?.addEventListener('click',()=>{current='tasks';setActive();render()})}
function setActive(){
  if(current!=='feedback')window.SoroFeedback?.unmount?.();
  if(current!=='reports')window.SoroReports?.unmount?.();
  if(current!=='talent-review')window.soroTalentReviewQueue?.unmount?.({clear:false});
  const active=current==='activity'?'reports':current==='talent-profile'?'vas':current==='client-record'?'clients':current==='client-placement'?(authenticatedClientRoles.has(currentAuthenticatedRole())?'client-candidate-review':'placements'):current;
  document.querySelectorAll('.nav-link').forEach(x=>x.classList.toggle('active',x.dataset.view===active));
  const profileButton=document.getElementById('role-switcher');
  if(profileButton?.dataset.accountAction==='my-profile')profileButton.classList.toggle('active',current==='my-profile');
  const mobileProfile=document.getElementById('client-mobile-profile');
  if(mobileProfile)mobileProfile.setAttribute('aria-current',current==='my-profile'?'page':'false');
  window.SoroSidebarNavigation?.sync({role:currentAuthenticatedRole(),userId:window.soroCurrentAccess?.user_id||'',view:current});
}
function goToMyProfile(){if(!viewAllowedForAuthenticatedRole('my-profile'))return;current='my-profile';selectedTalentId=null;selectedClientId=null;history.pushState({},'',`${location.pathname}#my-profile`);setActive();render();document.querySelector('.sidebar')?.classList.remove('open')}
function goToClientTalentProfile(){if(!viewAllowedForAuthenticatedRole('client-talent-profile'))return;current='client-talent-profile';selectedTalentId=null;selectedClientId=null;history.pushState({},'',`${location.pathname}#client-talent-profile`);setActive();render();document.querySelector('.sidebar')?.classList.remove('open')}
function goToClientDirectory(){if(!viewAllowedForAuthenticatedRole('clients'))return;current='clients';selectedTalentId=null;selectedClientId=null;history.pushState({},'',`${location.pathname}#clients`);setActive();render();document.querySelector('.sidebar')?.classList.remove('open')}
function goToTalentDirectory(){if(!viewAllowedForAuthenticatedRole('vas'))return;current='vas';selectedTalentId=null;selectedClientId=null;history.pushState({},'',`${location.pathname}#talent`);setActive();render()}
function openClientProfile(id){if(!viewAllowedForAuthenticatedRole('client-record')||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(id||'')))return;selectedClientId=id;selectedTalentId=null;current='client-record';history.pushState({clientId:id},'',`${location.pathname}#client/${id}`);setActive();render()}
let talentProfileReturnView='overview';
function openTalentProfile(id){if(!viewAllowedForAuthenticatedRole('talent-profile'))return;const previous=current;if(previous!=='talent-profile'&&viewAllowedForAuthenticatedRole(previous))talentProfileReturnView=previous;selectedTalentId=id;selectedClientId=null;current='talent-profile';history.pushState({talentId:id},'',`${location.pathname}#talent/${id}`);setActive();render()}
function goBackFromReadOnlyTalentProfile(){const destination=viewAllowedForAuthenticatedRole(talentProfileReturnView)?talentProfileReturnView:'overview';current=destination;selectedTalentId=null;selectedClientId=null;history.pushState({},'',`${location.pathname}#${destination}`);setActive();render()}
window.soroOpenDocumentCenter=function(opts={}){
  if(!viewAllowedForAuthenticatedRole('documents'))return;
  const params=new URLSearchParams();['requestId','subjectKind','subjectId'].forEach(k=>{if(opts[k])params.set(k,opts[k])});
  current='documents';selectedTalentId=null;selectedClientId=null;
  history.pushState({},'',location.pathname+'#documents'+(params.size?'?'+params:''));setActive();render();
};
window.soroOpenClientProfile=openClientProfile;
window.soroOpenTalentProfile=openTalentProfile;
window.soroGoBackFromReadOnlyTalentProfile=goBackFromReadOnlyTalentProfile;
nav.addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b||!viewAllowedForAuthenticatedRole(b.dataset.view))return;current=b.dataset.view;selectedTalentId=null;selectedClientId=null;history.pushState({},'',`${location.pathname}#${current}`);setActive();render();document.querySelector('.sidebar').classList.remove('open')});window.addEventListener('popstate',()=>{
  const talentMatch=location.hash.match(/^#talent\/([^/]+)$/),clientMatch=location.hash.match(/^#client\/([^/]+)$/),placementMatch=location.hash.match(/^#client-placement\/([^/]+)$/),reviewMatch=location.hash.match(/^#client-candidate-review\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if(/^#help\?ticketId=/.test(location.hash)){selectedTalentId=null;selectedClientId=null;current='help'}
  else if(/^#documents(?:\?|$)/.test(location.hash)){selectedTalentId=null;selectedClientId=null;current='documents'}
  else if(talentMatch){selectedTalentId=talentMatch[1];selectedClientId=null;current='talent-profile'}
  else if(clientMatch){selectedClientId=clientMatch[1];selectedTalentId=null;current='client-record'}
  else if(placementMatch){preferredHiringRequestId=placementMatch[1];selectedTalentId=null;selectedClientId=null;current='client-placement'}
  else if(reviewMatch){preferredHiringRequestId=reviewMatch[1];selectedTalentId=null;selectedClientId=null;current='client-candidate-review'}
  else{current=location.hash.slice(1)||'overview';selectedTalentId=null;selectedClientId=null}
  if(!viewAllowedForAuthenticatedRole(current)){current='overview';selectedTalentId=null;selectedClientId=null;history.replaceState({},'',`${location.pathname}#overview`)}setActive();render()
});document.getElementById('mobile-menu').addEventListener('click',()=>document.querySelector('.sidebar').classList.toggle('open'));document.getElementById('client-mobile-profile')?.addEventListener('click',goToMyProfile);document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close('cancel')});dialog.querySelector('.modal-close')?.addEventListener('click',()=>dialog.close('cancel'));dialog.querySelector('.modal-cancel')?.addEventListener('click',()=>dialog.close('cancel'))});
function applyRole(nextRole){
  if(actualAuthenticatedRole()!=='admin'||!roleConfig[nextRole])return;
  role=nextRole;
  current='overview';
  selectedTalentId=null;
  selectedClientId=null;
  const c=roleConfig[role];
  const profileButton=document.getElementById('role-switcher');
  const label=role==='admin'?(profileButton?.dataset.authenticatedRoleLabel||c.label):c.label;
  const person=role==='admin'?(profileButton?.dataset.authenticatedName||c.person):c.person;
  document.getElementById('role-label').textContent=label;
  document.querySelector('.profile strong').textContent=person;
  document.body.className=c.className;
  history.replaceState({},'',`${location.pathname}#overview`);
  syncAuthorizedNavigation();
  window.SoroGlobalSearch?.refreshRole?.();
  render();
  const workspaceName={admin:'Admin Panel',sales:'Sales Panel',talent:'Talent Management Panel',client:'Client Portal',va:'Talent Portal'}[role];
  toast(`${workspaceName} preview is active.`);
}
document.getElementById('role-switcher').addEventListener('click',event=>{if(event.currentTarget.dataset.accountAction==='my-profile'){goToMyProfile();return}if(event.currentTarget.dataset.accountAction==='workspace-preview'||actualAuthenticatedRole()==='admin')document.getElementById('role-dialog').showModal()});document.getElementById('role-dialog').addEventListener('close',e=>{if(roleConfig[e.target.returnValue])applyRole(e.target.returnValue)});
async function searchOperationsRecords({query,types,signal}={}){
  const normalizedQuery=String(query||'').trim();
  const visibleTypes=new Set(Array.isArray(types)?types:[]);
  if(adminPreviewingNonAdminWorkspace())return{query:normalizedQuery,clients:[],talent:[]};
  if(!window.soroSupabase?.auth?.getSession)throw new Error('Search is unavailable until the secure session is ready.');
  const {data,error}=await window.soroSupabase.auth.getSession();
  const token=data?.session?.access_token;
  if(error||!token)throw new Error('Sign in again to search Soro records.');
  const response=await fetch(`/.netlify/functions/global-search?q=${encodeURIComponent(normalizedQuery)}`,{
    method:'GET',
    headers:{Accept:'application/json',Authorization:`Bearer ${token}`},
    cache:'no-store',
    signal
  });
  const payload=await response.json().catch(()=>null);
  if(!response.ok||!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Search is temporarily unavailable.');
  return{
    query:String(payload.query||query||''),
    clients:visibleTypes.has('client')&&Array.isArray(payload.clients)?payload.clients:[],
    talent:visibleTypes.has('talent')&&Array.isArray(payload.talent)?payload.talent:[]
  };
}
function navigateGlobalSearchResult(result){
  if(!result||typeof result!=='object')return;
  if(result.kind==='record'&&result.entityType==='client'){openClientProfile(result.id);return}
  if(result.kind==='record'&&result.entityType==='talent'){openTalentProfile(result.id);return}
  if(result.kind==='view-all'&&result.entityType==='talent'&&viewAllowedForAuthenticatedRole('vas')){
    talentSearch=String(result.query||'').trim();
    current='vas';selectedTalentId=null;selectedClientId=null;
    history.pushState({},'',`${location.pathname}#talent`);setActive();render();
  }else if(result.kind==='view-all'&&result.entityType==='client')goToClientDirectory();
}
window.SoroGlobalSearch?.init?.({
  searchRecords:searchOperationsRecords,
  navigateResult:navigateGlobalSearchResult,
  getEffectiveRole:()=>adminPreviewingNonAdminWorkspace()?'':currentAuthenticatedRole()
});
function applicantRenderFingerprint(applicant){
  if(!applicant)return '';
  const normalize=value=>Array.isArray(value)?value.map(normalize):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,normalize(value[key])])):value;
  // A bookkeeping timestamp alone is not a visible profile change. Compare
  // every other field, including nested legacy values, without JSON key-order noise.
  const {updated_at,...visibleRecord}=applicant;
  return JSON.stringify(normalize(visibleRecord));
}
function applyLiveApplicants(applicants){
  const previous=liveApplicants.find(item=>String(item.id)===String(selectedTalentId));
  const next=applicants.find(item=>String(item.id)===String(selectedTalentId));
  const profileChanged=applicantRenderFingerprint(previous)!==applicantRenderFingerprint(next);
  liveApplicants=applicants;
  if(current==='vas'||(current==='talent-profile'&&profileChanged))render();
}
function liveApplicantAccessScope(value=window.soroCurrentAccess){
  return JSON.stringify([value?.user_id,value?.organization_id,actualAuthenticatedRole(value),value?.active,value?.must_change_password]);
}
async function refreshLiveApplicants(selectFields=talentProfileSelectFields,fallbackFields=null){
  const request=++liveApplicantsRequest;
  const client=window.soroSupabase,access=window.soroCurrentAccess||{};
  const scope=liveApplicantAccessScope(access);
  if(!client||!access.user_id||!access.organization_id||access.active===false||access.must_change_password===true||!viewAllowedForAuthenticatedRole('vas')){liveApplicantsScope='';applyLiveApplicants([]);return;}
  if(liveApplicantsScope!==scope){
    const hadRecords=liveApplicants.length>0;
    liveApplicants=[];liveApplicantsScope=scope;
    if(hadRecords&&(current==='vas'||current==='talent-profile'))render();
  }
  const stillCurrent=()=>request===liveApplicantsRequest&&window.soroSupabase===client
    &&scope===liveApplicantAccessScope(window.soroCurrentAccess)&&viewAllowedForAuthenticatedRole('vas');
  const read=fields=>client.from('applicants').select(fields).eq('organization_id',access.organization_id)
    .is('archived_at',null).order('application_received_at',{ascending:false});
  let result;
  try{
    result=await read(selectFields);
    if(!stillCurrent())return;
    if(result.error&&fallbackFields){result=await read(fallbackFields);if(!stillCurrent())return;}
  }catch{if(stillCurrent())applyLiveApplicants([]);return;}
  if(!stillCurrent())return;
  applyLiveApplicants(result.error||!Array.isArray(result.data)?[]:result.data);
}
async function loadLiveApplicants(){return refreshLiveApplicants();}
async function loadOwnTalentProfile(){
  const access=window.soroCurrentAccess||{};
  const request=++ownTalentProfileRequest;
  if(actualAuthenticatedRole(access)!=='virtual_assistant'){
    ownTalentProfile=null;ownTalentProfileState='idle';
    if(isTalentSelfProfileView())render();
    return;
  }
  if(!window.soroSupabase||!access.user_id||!access.organization_id){
    ownTalentProfile=null;ownTalentProfileState='error';
    if(isTalentSelfProfileView())render();
    return;
  }
  ownTalentProfile=null;ownTalentProfileState='loading';
  if(isTalentSelfProfileView())render();
  const {data:applicant,error}=await window.soroSupabase.from('applicants')
    .select(talentSelfProfileSelectFields)
    .eq('auth_user_id',access.user_id)
    .eq('organization_id',access.organization_id)
    .is('archived_at',null)
    .maybeSingle();
  if(request!==ownTalentProfileRequest)return;
  if(error){ownTalentProfile=null;ownTalentProfileState='error'}
  else{ownTalentProfile=applicant||null;ownTalentProfileState=applicant?'ready':'empty'}
  if(isTalentSelfProfileView()){
    selectedTalentId=ownTalentProfile?.id||null;
    render();
  }
}
function classifyDocument(d){if(d.document_type&&d.document_type!=='application_attachment')return d.document_type;const v=`${d.file_name||''} ${d.external_url||''}`.toLowerCase();if(/loom|introduction video/.test(v))return'introduction_video';if(/resume|résumé|\bcv\b/.test(v))return'resume';if(/english|ielts|toeic|duolingo|language test/.test(v))return'english_proof';if(/\bdisc\b/.test(v))return'disc_assessment';if(/enneagram/.test(v))return'enneagram_assessment';if(/mbti|16personalities|16 personalities/.test(v))return'mbti_assessment';if(/internet|speedtest|speed test|mbps|wifi/.test(v))return'internet_proof';if(/equipment|laptop|computer|headset|webcam|device/.test(v))return'equipment_proof';if(/assessment|personality|behavioral|behavioural/.test(v))return'assessment';return'application_attachment'}
async function loadTalentProfileDocuments(){const applicant=currentTalentProfileApplicant(),target=document.getElementById('profile-documents');if(!applicant||!target||!window.soroSupabase)return;const {data:documents,error}=await window.soroSupabase.from('documents').select('id,file_name,document_type,status,created_at,storage_path,external_url').eq('applicant_id',applicant.id).order('created_at',{ascending:false});if(error){target.innerHTML='<p>Documents could not be loaded for this Talent profile.</p>';return}const all=documents||[],photo=all.find(d=>classifyDocument(d)==='profile_photo');if(photo?.storage_path){const {data:signed}=await window.soroSupabase.storage.from('soro-private-documents').createSignedUrl(photo.storage_path,3600);if(signed?.signedUrl){const h=document.getElementById('talent-headshot');if(h)h.innerHTML=`<img src="${escapeHtml(signed.signedUrl)}" alt="${escapeHtml(applicant.full_name)} headshot" />`}}const groups=new Map();all.filter(d=>classifyDocument(d)!=='profile_photo').forEach(d=>{const type=classifyDocument(d);if(!groups.has(type))groups.set(type,[]);groups.get(type).push(d)});target.innerHTML=groups.size?[...groups.entries()].map(([type,items])=>`<section class="document-group"><h3>${escapeHtml(documentLabels[type]||titleCase(type))}<span>${items.length}</span></h3>${items.map(d=>`<article class="document-item"><span class="document-icon">${type==='resume'?'▤':type==='english_proof'?'A':type==='internet_proof'?'⌁':type==='equipment_proof'?'▣':'◫'}</span><span><strong>${escapeHtml(d.file_name)}</strong><small>${escapeHtml(titleCase(d.status||'uploaded'))} · ${d.created_at?escapeHtml(new Date(d.created_at).toLocaleDateString()):'Date not recorded'}</small></span>${d.storage_path?`<button class="text-button open-private-document" data-storage-path="${escapeHtml(d.storage_path)}">View</button>`:'<span class="tag neutral">Link only</span>'}</article>`).join('')}</section>`).join(''):'<div class="documents-empty"><strong>No documents attached yet</strong><p>Imported application files and new uploads will appear here.</p></div>';target.querySelectorAll('.open-private-document').forEach(b=>b.addEventListener('click',()=>openPrivateDocument(b.dataset.storagePath)))}
async function uploadHeadshot(file){if(isTalentSelfProfileView())return;const applicant=currentTalentProfileApplicant();if(!applicant||!file)return;if(!file.type.startsWith('image/')||file.size>5*1024*1024){toast('Choose a JPG, PNG, or WebP image under 5 MB.');return}const safe=file.name.toLowerCase().replace(/[^a-z0-9._-]+/g,'-'),path=`applicants/${applicant.id}/headshots/${Date.now()}-${safe}`,label=document.querySelector('.headshot-upload');if(label)label.firstChild.textContent='Uploading…';try{const {error:uploadError}=await window.soroSupabase.storage.from('soro-private-documents').upload(path,file,{contentType:file.type,upsert:false});if(uploadError)throw uploadError;const {error:recordError}=await window.soroSupabase.from('documents').insert({organization_id:applicant.organization_id,applicant_id:applicant.id,file_name:file.name,storage_path:path,document_type:'profile_photo',status:'uploaded'});if(recordError)throw recordError;toast('Headshot uploaded to this secure Talent profile.');await loadTalentProfileDocuments()}catch(error){toast(error.message||'The headshot could not be uploaded.')}finally{if(label)label.firstChild.textContent='Upload headshot'}}
async function openPrivateDocument(storagePath){const viewer=window.open('','_blank');if(!viewer){toast('Allow pop-ups for Soro to view private documents.');return}viewer.opener=null;viewer.document.title='Opening secure Soro document…';const {data,error}=await window.soroSupabase.storage.from('soro-private-documents').createSignedUrl(storagePath,60);if(error||!data?.signedUrl){viewer.close();toast('This private document could not be opened.');return}viewer.location.href=data.signedUrl}
async function openTalentReviewResume(applicantId){
  const id=String(applicantId||'').trim(),organizationId=String(window.soroCurrentAccess?.organization_id||'').trim();
  if(!window.soroTalentReviewQueue?.canOpenForRole?.(actualAuthenticatedRole())||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(organizationId)||!window.soroSupabase)return;
  const viewer=window.open('','_blank');
  if(!viewer){toast('Allow pop-ups for Soro to open secure resumes.');return}
  viewer.opener=null;
  viewer.document.title='Opening secure Soro resume…';
  try{
    const {data:documents,error:documentError}=await window.soroSupabase.from('documents')
      .select('storage_path')
      .eq('organization_id',organizationId)
      .eq('applicant_id',id)
      .eq('document_type','resume')
      .neq('status','rejected')
      .not('storage_path','is',null)
      .order('created_at',{ascending:false})
      .order('id',{ascending:false})
      .limit(1);
    const storagePath=documents?.[0]?.storage_path;
    if(documentError||!storagePath)throw new Error('resume_missing');
    const {data:signed,error:signingError}=await window.soroSupabase.storage.from('soro-private-documents').createSignedUrl(storagePath,60);
    if(signingError||!signed?.signedUrl)throw new Error('resume_unavailable');
    viewer.location.href=signed.signedUrl;
  }catch(error){
    viewer.close();
    toast(error?.message==='resume_missing'?'A secure resume is not attached to this Talent profile yet.':'This secure resume could not be opened. Refresh and try again.');
  }
}
async function importDriveFiles(){const button=document.getElementById('import-drive');if(!button)return;button.disabled=true;button.textContent='Starting import…';toast('Checking your Admin access and preparing the secure file import…');try{if(!window.soroSupabase)throw new Error('Soro sign-in is still loading. Refresh this page and try again.');const {data:{session},error:sessionError}=await window.soroSupabase.auth.getSession();if(sessionError||!session)throw new Error('Please sign in to Soro again, then retry the import.');let offset=0,imported=0,skipped=0,total=0,loomArchived=0,failed=[];do{button.textContent=total?`Importing ${Math.min(offset+1,total)}/${total}…`:'Importing…';const response=await fetch('/.netlify/functions/import-google-drive',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({offset})}),responseText=await response.text();let report;try{report=JSON.parse(responseText)}catch{throw new Error(`The import server returned an unexpected response (${response.status}).`)}if(!response.ok)throw new Error(report.error||'The import could not start.');imported+=report.imported||0;skipped+=report.skipped||0;loomArchived+=report.loomArchived||0;failed=failed.concat(report.failed||[]);total=report.total||0;offset=report.nextOffset;if(report.complete)break}while(offset<total);toast(`${imported} private files attached${loomArchived?`, including ${loomArchived} Loom recording${loomArchived===1?'':'s'}`:''}. ${skipped} already existed.${failed.length?` ${failed.length} need review.`:''}`);if(failed.length)console.warn('Legacy file import review needed:',failed);await loadLiveApplicants()}catch(error){toast(error.message||'The import could not start.')}finally{button.disabled=false;button.textContent='Import legacy files'}}
window.addEventListener('soro:talent-workday-updated',()=>{
  if(current==='overview'&&actualAuthenticatedRole()==='virtual_assistant')render();
});
window.addEventListener('soro:active-talent-today-updated',()=>{
  if(current==='overview'&&window.soroActiveTalentToday?.canLoadForRole(actualAuthenticatedRole()))render();
});
window.addEventListener('soro:talent-time-off-updated',()=>{
  if(current==='overview'&&window.soroTalentTimeOff?.canLoadForRole(actualAuthenticatedRole()))render();
});
window.addEventListener('soro:active-talent-open-profile',event=>{
  const applicantId=String(event.detail?.applicantId||'');
  if(!window.soroActiveTalentToday?.canLoadForRole(actualAuthenticatedRole())||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(applicantId))return;
  openTalentProfile(applicantId);
});
window.addEventListener('soro:talent-review-open-queue',event=>{
  if(!viewAllowedForAuthenticatedRole('talent-review'))return;
  current='talent-review';
  selectedTalentId=null;
  history.pushState({},'',`${location.pathname}#talent-review`);
  setActive();
  render();
  document.querySelector('.sidebar')?.classList.remove('open');
  if(event.detail?.interviewApplicantId)window.soroTalentReviewQueue?.openInterviewFromTask?.(event.detail.interviewApplicantId);
});
window.addEventListener('soro:talent-review-open-profile',event=>{
  const applicantId=String(event.detail?.applicantId||'');
  if(!window.soroTalentReviewQueue?.canOpenForRole?.(actualAuthenticatedRole())||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(applicantId))return;
  openTalentProfile(applicantId);
});
window.addEventListener('soro:talent-review-open-resume',event=>{
  openTalentReviewResume(event.detail?.applicantId);
});
window.addEventListener('soro:talent-review-queue-updated',()=>{
  if(viewAllowedForAuthenticatedRole('vas'))loadLiveApplicants();
  if(current==='overview'&&window.soroTalentReviewQueue?.canOpenForRole?.(actualAuthenticatedRole()))render();
});
window.addEventListener('soro:ownership-updated',event=>{
  if(event.detail?.kind==='talent'&&actualAuthenticatedRole()==='admin')loadLiveApplicants();
});
window.addEventListener('soro:client-workflow-action',event=>{
  const action=String(event.detail?.action||'').toLowerCase();
  const requestId=String(event.detail?.requestId||'').toLowerCase();
  preferredHiringRequestId=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId)?requestId:'';
  if(['find_talent','request'].includes(action)){
    if(!viewAllowedForAuthenticatedRole('available-talent'))return;
    current='available-talent';selectedTalentId=null;selectedClientId=null;
    history.pushState({},'',`${location.pathname}#available-talent`);
    setActive();render();document.querySelector('.sidebar')?.classList.remove('open');
    return;
  }
  if(['shortlist','client_review'].includes(action)){
    if(!viewAllowedForAuthenticatedRole('client-shortlists'))return;
    current='client-shortlists';selectedTalentId=null;selectedClientId=null;
    history.pushState({},'',`${location.pathname}#client-shortlists`);
    setActive();render();document.querySelector('.sidebar')?.classList.remove('open');
    return;
  }
  if(['interview','selection','placement','onboarding'].includes(action))openClientPlacementWorkflow(preferredHiringRequestId);
});
window.addEventListener('soro:client-shortlist-open',event=>{
  if(!viewAllowedForAuthenticatedRole('client-shortlists'))return;
  const accessRole=currentAuthenticatedRole();
  preferredHiringRequestId=String(event.detail?.requestId||'');
  current='client-shortlists';
  selectedTalentId=null;
  selectedClientId=null;
  history.pushState({},'',`${location.pathname}#client-shortlists`);
  setActive();
  window.soroClientShortlistWorkflow?.mount?.(root,clientShortlistMountOptions(accessRole,'sales',event.detail?.requestId));
  document.querySelector('.sidebar')?.classList.remove('open');
});
window.addEventListener('soro:client-shortlist-open-bench',()=>{
  if(!viewAllowedForAuthenticatedRole('available-talent'))return;
  current='available-talent';
  selectedTalentId=null;
  selectedClientId=null;
  history.pushState({},'',`${location.pathname}#available-talent`);
  setActive();
  render();
  document.querySelector('.sidebar')?.classList.remove('open');
});
window.addEventListener('soro:client-shortlist-open-profile',event=>{
  const applicantId=String(event.detail?.applicantId||'');
  if(!viewAllowedForAuthenticatedRole('talent-profile')||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(applicantId))return;
  openTalentProfile(applicantId);
});
function openClientPlacementWorkflow(requestId){
  const id=String(requestId||'').toLowerCase();
  if(!viewAllowedForAuthenticatedRole('client-placement')||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id))return false;
  preferredHiringRequestId=id;
  current='client-placement';selectedTalentId=null;selectedClientId=null;
  history.pushState({hiringRequestId:id},'',`${location.pathname}#client-placement/${id}`);
  setActive();render();document.querySelector('.sidebar')?.classList.remove('open');
  return true;
}
window.addEventListener('soro:client-placement-open',event=>openClientPlacementWorkflow(event.detail?.requestId));
window.addEventListener('click',event=>{
  const button=event.target.closest?.('[data-placement-ending-open]');
  if(!button||!window.SoroPlacementEnding?.canManage(currentAuthenticatedRole())||adminPreviewingNonAdminWorkspace())return;
  current='placements';history.pushState({endingPlacementId:button.dataset.placementEndingOpen},'',`${location.pathname}#placements`);setActive();render();
});
window.addEventListener('soro:placement-work-log-open',event=>{
  if(!['admin','talent_management'].includes(currentAuthenticatedRole())||adminPreviewingNonAdminWorkspace())return;
  current='work-log';history.pushState({workLogPlacement:event.detail?.placementId},'',`${location.pathname}#work-log`);setActive();render();
});
window.addEventListener('soro:task-center-updated',()=>{
  if(current==='tasks'||(current==='overview'&&['admin','sales','talent'].includes(role)))render();
});
window.addEventListener('soro:task-center-open-tasks',()=>{
  if(!viewAllowedForAuthenticatedRole('tasks'))return;
  current='tasks';
  selectedTalentId=null;
  selectedClientId=null;
  history.pushState({},'',`${location.pathname}#tasks`);
  setActive();
  render();
  document.querySelector('.sidebar')?.classList.remove('open');
});
window.addEventListener('soro:task-center-error',event=>{
  toast(event.detail?.message||'The task could not be updated.');
});
window.addEventListener('soro-auth-changed',event=>{
  liveApplicantsRequest+=1;
  liveApplicants=[];liveApplicantsScope='';
  syncAuthorizedNavigation(event.detail.access);
  if(event.detail.session&&viewAllowedForAuthenticatedRole('vas'))loadLiveApplicants();else liveApplicants=[];
  if(event.detail.session&&actualAuthenticatedRole(event.detail.access)==='virtual_assistant')loadOwnTalentProfile();
  else{ownTalentProfileRequest+=1;ownTalentProfile=null;ownTalentProfileState='idle'}
  render();
});
const initialTalentHash=location.hash.match(/^#talent\/([^/]+)$/);
const initialClientHash=location.hash.match(/^#client\/([^/]+)$/);
const initialPlacementHash=location.hash.match(/^#client-placement\/([^/]+)$/);
const initialReviewHash=location.hash.match(/^#client-candidate-review\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
if(/^#help\?ticketId=/.test(location.hash)){current='help'}
else if(/^#documents(?:\?|$)/.test(location.hash)){current='documents'}
else if(initialTalentHash){current='talent-profile';selectedTalentId=initialTalentHash[1]}
else if(initialClientHash){current='client-record';selectedClientId=initialClientHash[1]}
else if(initialPlacementHash){current='client-placement';preferredHiringRequestId=initialPlacementHash[1]}
else if(initialReviewHash){current='client-candidate-review';preferredHiringRequestId=initialReviewHash[1]}
else if(location.hash.slice(1) in data||['help','feedback','activity','work-log','my-profile','client-talent-profile','client-candidate-review','client-shortlists','talent-my-profile','talent-review','available-talent'].includes(location.hash.slice(1))){current=location.hash.slice(1)}
render();

function displayTalentName(value){
  const raw=String(value||'').trim().replace(/\s+/g,' ');
  if(!raw)return 'Talent';
  const word=value=>value.split(/([-'])/).map(part=>/^[-']$/.test(part)?part:part?part.charAt(0).toUpperCase()+part.slice(1).toLowerCase():'').join('');
  const words=value=>value.trim().split(/\s+/).filter(Boolean).map(word).join(' ');
  const parts=raw.split(',').map(value=>value.trim()).filter(Boolean);
  if(parts.length>1)return `${words(parts[0])}, ${words(parts.slice(1).join(' '))}`;
  const tokens=raw.split(/\s+/).filter(Boolean);
  return tokens.length>1?`${words(tokens[0])}, ${words(tokens.slice(1).join(' '))}`:words(raw);
}

function applyTalentDisplayNames(){
  root.querySelectorAll('.talent-cell strong,.profile-identity h1').forEach(element=>{
    const formatted=displayTalentName(element.textContent);
    if(element.textContent!==formatted)element.textContent=formatted;
  });
  root.querySelectorAll('.page-heading .eyebrow').forEach(element=>{
    if(element.textContent.trim()==='Soro Operations')element.textContent='Soro Ops';
  });
}

new MutationObserver(applyTalentDisplayNames).observe(root,{childList:true,subtree:true});
applyTalentDisplayNames();

root.addEventListener('input',event=>{
  const input=event.target;
  if(input.id!=='talent-search')return;
  event.stopImmediatePropagation();
  const cursor=input.selectionStart??input.value.length;
  talentSearch=input.value;
  render();
  const refreshed=document.getElementById('talent-search');
  if(refreshed){refreshed.focus();refreshed.setSelectionRange(cursor,cursor)}
},true);
root.addEventListener('click',event=>{
 const button=event.target.closest('[data-document-profile]');if(!button)return;
 window.soroOpenDocumentCenter({subjectKind:button.dataset.documentProfile,subjectId:button.dataset.documentSubject});
});
