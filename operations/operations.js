const data={overview:{title:'Admin Panel',caption:'Here is what needs your attention.',metrics:[['Tasks needing attention','5','2 overdue','alert'],['Client pipeline','18','4 ready for matching',''],['Active Talent today','—','Loading live attendance…',''],['Billing review','3','1 due this week','warning']],primary:'Priority work',items:[['red','Review missing client agreement','Haven & Co. · placement begins Monday','Today'],['','Follow up on payout verification','Finance · 1 Wise recipient','Tomorrow']],secondary:'Soro at a glance'},tasks:{title:'My Tasks',caption:'Your active work, in priority order.',table:['Task','Related to','Due','Owner'],rows:[['Review missing client agreement','Haven & Co.','Today','Matt Johnson'],['Update client discovery','Northstar Legal','Tomorrow','Matt Johnson'],['Review payout exception','Daniel Cruz','Friday','Billing']]},clients:{title:'Client Pipeline',caption:'Every client, lead, and next action in one place.',table:['Client','Stage','Next action','Owner'],rows:[['Haven & Co.','Placement onboarding','Sign agreement','Morgan Lee'],['Northstar Legal','Discovery','Complete required checklist','Matt Johnson'],['Brightlane Medical','Ready for matching','Build shortlist','Morgan Lee'],['Urban Ledger','New inquiry','Claim or assign','Unassigned']]},vas:{title:'Talent Directory',caption:'Search, filter, and open a complete Talent profile from any row.',table:['Talent','Application status','Work status','Location & time zone','Readiness','Owner'],rows:[]},placements:{title:'Placement Journey',caption:'Client and Talent readiness, side by side.',table:['Client','Talent','Status','Next action'],rows:[['Haven & Co.','Mariel Santos','Onboarding','Client agreement'],['Brightlane Medical','Arielle Tan','Interviewing','Confirm interview'],['Urban Ledger','—','Discovery','Complete role requirements']]},documents:{title:'Document Center',caption:'Assigned forms, uploads, and signed agreements.',table:['Document','Related to','Status','Action'],rows:[['Soro client agreement','Haven & Co.','Awaiting signature','Send reminder'],['Contractor agreement','Mariel Santos','Signed','View'],['HIPAA acknowledgment','Brightlane Medical','Needs review','Review upload']]},reports:{title:'Reports',caption:'Saved reports and quick builds, only for data you are authorized to see.',table:['Report','Last run','Owner','Action'],rows:[['Sales Pipeline Health','Today','Sales Management','Open'],['Active Talent Attendance','Today','Talent Management','Open'],['Payout History','Aug 14','Billing','Open'],['Client Feedback Trends','Aug 12','Admin','Open']]}};
let current='overview',role='admin',liveApplicants=[],selectedTalentId=null,talentSearch='',talentStatus='all',ownTalentProfile=null,ownTalentProfileState='idle',ownTalentProfileRequest=0;
const roleConfig={admin:{label:'Administrator',person:'Matt Johnson',className:'role-admin'},sales:{label:'Sales Associate',person:'Morgan Lee',className:'role-sales'},talent:{label:'Talent Management',person:'Jordan Reed',className:'role-talent'},client:{label:'Client Administrator',person:'Avery Parker',className:'role-client'},va:{label:'Talent',person:'Mariel Santos',className:'role-va'}};
const roleDashboards={sales:{title:'Sales Panel',caption:'Your priority client work is ready.',metrics:[['Tasks needing attention','6','2 overdue','alert'],['My client pipeline','18','4 ready for matching',''],['Open hiring requests','7','3 awaiting shortlist',''],['My available Talent','14','6 available now','']],primary:'Priority accounts needing action',items:[['red','Complete discovery for Northstar Legal','Required specialty checklist still has 2 items','Today'],['','Send shortlist to Brightlane Medical','Three selected Talent members are ready to present','Today'],['','Follow up after client interview','Haven & Co. · Mariel Santos','Tomorrow']],secondary:'Pipeline movement'},talent:{title:'Talent Management Panel',caption:'Your Talent readiness and support work is ready.',metrics:[['Talent actions needing attention','8','3 need follow-up','alert'],['Active Talent today','—','Loading live attendance…',''],['Talent Review Queue','12','5 interview ready',''],['Upcoming reviews','4','2 this week','']],primary:'Priority Talent support',items:[['red','Check in with Alex Ramos','15 minutes past scheduled start','Now'],['','Review 2 incomplete applications','Video or equipment proof missing','Today'],['','Prepare Mariel’s onboarding session','Placement begins Monday','Tomorrow']],secondary:'Talent readiness'},client:{title:'Client Portal',caption:'Your active Talent support and Soro actions are all in one place.',metrics:[['Action needed','2','1 document is awaiting your signature','alert'],['Your current Talent','3','All active placements',''],['Open hiring requests','1','Next review tomorrow',''],['Invoices','1','Due this Friday','warning']],primary:'Action needed',items:[['red','Sign the Soro client agreement','Haven & Co. · secure document ready','Today'],['','Choose interview windows','Operations support role · 3 candidates ready','Tomorrow']],secondary:'Your current Talent'},va:{title:'Talent Portal',caption:'Your workday, progress, and support are all here.',metrics:[['Today’s work','—','Current placement status will appear here',''],['Dream Pathway','1 next step','Review education options',''],['Next payout','Friday','Current pay period',''],['Documents','1 action','Update Wise recipient verification','warning']],primary:'Action needed',items:[['','Complete your Dream Pathway action','Choose two education programs to discuss at your next review','This week'],['','Update payout verification','Wise recipient details need confirmation','This week']],secondary:'Your progress'}};
const root=document.getElementById('view-root'),nav=document.getElementById('main-nav');
const authenticatedEmployeeViews=Object.freeze({
  admin:new Set(['overview','tasks','clients','vas','talent-profile','placements','documents','reports','employees','payroll','help']),
  talent_management:new Set(['overview','tasks','clients','vas','talent-profile','placements','documents','reports','talent-payout-review','help']),
  sales:new Set(['overview','tasks','clients','placements','reports','help']),
  sales_management:new Set(['overview','tasks','clients','placements','reports','help']),
  billing:new Set(['overview','tasks','clients','placements','documents','reports','help']),
  client_admin:new Set(['overview','client-talent-profile','my-profile','help']),
  client_reviewer:new Set(['overview','client-talent-profile','my-profile','help']),
  client_billing:new Set(['overview','my-profile','help']),
  virtual_assistant:new Set(['overview','talent-my-profile','tasks','documents','help'])
});
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
const clientWorkspacePreviewProfile=Object.freeze({
  contact:{fullName:'Sample Client Administrator',phone:'(555) 010-0100'},
  company:{name:'Example Company',industry:'Professional services',addressLine1:'100 Example Avenue',addressLine2:'Suite 200',city:'Dallas',stateRegion:'Texas',postalCode:'75201',country:'United States',phone:'(555) 010-0200',website:'https://example.com'},
  permissions:{canEditCompany:true,editableFields:['contactFullName','contactPhone','companyAddressLine1','companyAddressLine2','companyCity','companyStateRegion','companyPostalCode','companyCountry','companyPhone','companyWebsite']},
  signInEmail:'client.preview@example.com'
});
const clientWorkspacePreviewTalent=Object.freeze({talents:[{
  id:'preview-talent',displayName:'Example, Taylor Alex',
  location:{country:'Philippines',timeZone:'Philippine Standard Time · UTC+08:00 (Asia/Manila)'},
  skills:{verified:[{name:'Calendar management',years:'4'},{name:'Insurance verification',years:'3'},{name:'Social media scheduling',years:'2'}]},
  experience:{years:'5',summary:'Experienced in client support, administrative coordination, and remote operations.',educationAndTraining:'Business administration and client-service training'},
  screening:{englishResult:'Advanced professional proficiency',personalityResult:'Collaborative, organized, and service focused',computerSpecifications:'Modern laptop · 16 GB memory',internetSpeed:'95 Mbps download · 45 Mbps upload'},
  assignments:[{id:'preview-assignment',status:'active',startDate:'2026-08-01',scheduleSummary:'Monday–Friday · 8:00 AM–5:00 PM CT'}]
}]});
const talentWorkspacePreviewProfile=Object.freeze({
  id:'preview-own-talent',organization_id:'preview-organization',auth_user_id:'local-va-preview',
  full_name:'Santos, Mariel Anne',preferred_name:'Mariel',gender_identity:'female',pronouns:['she_her'],
  email:'mariel.preview@example.com',phone:'+63 917 555 0142',location:'Cebu City, Cebu',country:'Philippines',
  address_line_1:'100 Sample Avenue',city:'Cebu City',province_region:'Cebu',postal_code:'6000',
  timezone:'Asia/Manila',status:'active',work_status:'currently_employed',availability_note:'Full time',
  expected_hourly_rate_text:'$7–$9 USD per hour',greatest_dream:'Build a stable career and create more opportunities for my family.',
  application_received_at:'2026-08-12T12:00:00.000Z',submitted_at:'2026-08-12T12:00:00.000Z',
  verified_skills:['Calendar management','Client communication','Medical scheduling'],
  self_reported_experience_areas:['healthcare','general_admin','customer_support'],
  self_reported_skills:['Calendar management','Client communication','Medical scheduling','Insurance verification','Inbox management'],
  relevant_experience_years:'4',relevant_experience_summary:'Four years supporting remote teams and coordinating client schedules.',
  education_training_summary:'Business administration and healthcare support training.',
  english_test_result:'92%',personality_profile_score:'DISC: S 35, C 29 | Enneagram: Type 2 | MBTI: ENFJ-A',
  computer_specs:'System: Laptop | Processor: Intel Core i5 | Memory: 16 GB | Storage: 512 GB SSD | Operating system: Windows 11',
  internet_speed:'95 Mbps download · 45 Mbps upload',legacy_application_data:{verified_skill_experience:{'Calendar management':4,'Client communication':4,'Medical scheduling':3}}
});
const talentProfileSelectFields='id,organization_id,auth_user_id,full_name,preferred_name,birth_date,gender_identity,gender_identity_self_description,pronouns,pronouns_self_description,email,phone,location,country,address_line_1,address_line_2,city,province_region,postal_code,timezone,timezone_other_detail,status,work_status,work_status_other_detail,availability_note,expected_hourly_rate,expected_hourly_rate_max,expected_hourly_rate_text,education_level,greatest_dream,referral_source,dedicated_workspace,has_laptop,has_noise_canceling_headset,has_reliable_internet,has_backup_internet,has_emergency_workspace,equipment_summary,internet_summary,english_proficiency,assessment_summary,english_test_result,personality_profile_score,computer_specs,internet_speed,loom_video_url,resume_url,application_received_at,submitted_at,verified_skills,self_reported_experience_areas,self_reported_skills,other_experience_specialty,relevant_experience_years,relevant_experience_summary,education_training_summary,skill_profile_updated_at,talent_review_owner_id,sales_owner_id,talent_support_owner_id,legacy_application_data';
const talentSelfProfileSelectFields='id,organization_id,auth_user_id,full_name,preferred_name,birth_date,gender_identity,gender_identity_self_description,pronouns,pronouns_self_description,email,phone,location,country,address_line_1,address_line_2,city,province_region,postal_code,timezone,timezone_other_detail,status,work_status,work_status_other_detail,availability_note,expected_hourly_rate,expected_hourly_rate_max,expected_hourly_rate_text,greatest_dream,dedicated_workspace,has_laptop,equipment_summary,internet_summary,english_test_result,personality_profile_score,computer_specs,internet_speed,application_received_at,submitted_at,verified_skills,self_reported_experience_areas,self_reported_skills,other_experience_specialty,relevant_experience_years,relevant_experience_summary,education_training_summary,skill_profile_updated_at,legacy_application_data';
function isTalentSelfProfileView(){return current==='talent-my-profile'}
function currentTalentProfileApplicant(){
  if(isTalentSelfProfileView())return isAdminWorkspacePreview('va')?talentWorkspacePreviewProfile:ownTalentProfile;
  return liveApplicants.find(applicant=>String(applicant.id)===String(selectedTalentId))||null;
}
window.soroCurrentTalentProfileApplicant=currentTalentProfileApplicant;
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
  const allowed=authenticatedEmployeeViews[accessRole]||new Set();
  const clientPortal=authenticatedClientRoles.has(accessRole);
  document.querySelectorAll('#main-nav [data-view]').forEach(button=>{
    button.hidden=!allowed.has(button.dataset.view);
  });
  const actualRole=actualAuthenticatedRole(access);
  const payrollNav=document.getElementById('payroll-nav');
  const talentPayoutReviewNav=document.getElementById('talent-payout-review-nav');
  if(payrollNav)payrollNav.hidden=actualRole!=='admin'||accessRole!=='admin';
  if(talentPayoutReviewNav)talentPayoutReviewNav.hidden=actualRole!=='talent_management'||accessRole!=='talent_management';
  document.querySelectorAll('[data-notification-view]').forEach(button=>{
    button.hidden=clientPortal||!allowed.has(button.dataset.notificationView);
  });
  const notificationsButton=document.getElementById('notifications-button');
  if(notificationsButton)notificationsButton.hidden=clientPortal||accessRole==='virtual_assistant';
  const globalSearch=document.getElementById('global-search')?.closest('.global-search');
  if(globalSearch)globalSearch.hidden=clientPortal||accessRole==='virtual_assistant';
  const overviewNav=document.getElementById('overview-nav');
  if(overviewNav)overviewNav.textContent=clientPortal||accessRole==='virtual_assistant'?'Dashboard':'Overview';
  if(!allowed.has(current)){
    current='overview';selectedTalentId=null;
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
function metricCard(m,i){return `<button class="metric ${m[3]}" data-metric="${i}"><p>${m[0]}</p><strong>${m[1]}</strong><small>${m[2]}</small></button>`}function list(items){return `<div class="list">${items.map(x=>`<div class="list-item"><span class="status-dot ${x[0]}"></span><span><strong>${x[1]}</strong><small>${x[2]}</small></span><span class="pill">${x[3]}</span></div>`).join('')}</div>`}function chart(){return `<div class="bar-chart" aria-label="Active placements trend">${[46,62,51,77,66,91,83].map((h,i)=>`<div class="bar" style="height:${h}%"><span>${['M','T','W','T','F','S','S'][i]}</span></div>`).join('')}</div>`}
function readinessSummary(a){const x=[];if(a.resume_url)x.push('Résumé');if(a.english_proficiency)x.push('English');if(a.equipment_summary)x.push('Equipment');return x.length?x.slice(0,2).join(' · '):'Profile review'}
function talentDirectory(){const query=talentSearch.trim().toLowerCase();const applicants=liveApplicants.filter(a=>{const matches=!query||[a.full_name,a.email,a.phone,a.location,a.timezone,a.status,a.work_status].filter(Boolean).join(' ').toLowerCase().includes(query);return matches&&(talentStatus==='all'||a.status===talentStatus)});const statuses=[...new Set(liveApplicants.map(a=>a.status).filter(Boolean))];const rows=applicants.length?applicants.map(a=>`<tr class="talent-row" data-talent-id="${escapeHtml(a.id)}" tabindex="0" role="link" aria-label="Open ${escapeHtml(a.full_name)} profile"><td><div class="talent-cell"><span class="mini-avatar">${escapeHtml(initials(a.full_name))}</span><span><strong>${escapeHtml(a.full_name)}</strong><small>${escapeHtml(a.email||'No email recorded')}</small></span></div></td><td><span class="tag">${escapeHtml(titleCase(a.status))}</span></td><td>${escapeHtml(titleCase(a.work_status))}</td><td>${escapeHtml(formatTalentLocationTimeZone(a.location,recordedTalentTimeZone(a)))}</td><td>${escapeHtml(readinessSummary(a))}</td><td>${a.talent_review_owner_id?'Assigned':'Unassigned'}</td></tr>`).join(''):`<tr><td class="empty" colspan="6">No Talent profiles match those filters.</td></tr>`;return `<div class="directory-toolbar panel"><label class="directory-search"><span>⌕</span><input id="talent-search" type="search" value="${escapeHtml(talentSearch)}" placeholder="Search Talent by name, email, location, skill, or status" /></label><label class="directory-filter">Status<select id="talent-status-filter"><option value="all">All statuses</option>${statuses.map(s=>`<option value="${escapeHtml(s)}" ${s===talentStatus?'selected':''}>${escapeHtml(titleCase(s))}</option>`).join('')}</select></label><span class="directory-count">${applicants.length} of ${liveApplicants.length} profiles</span></div><div class="panel table-wrap"><table class="data-table talent-directory-table"><thead><tr>${data.vas.table.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`}
function table(d){const body=d.rows.length?d.rows.map(r=>`<tr>${r.map((x,i)=>`<td>${i===1&&current==='clients'?`<span class="tag">${escapeHtml(x)}</span>`:escapeHtml(x)}</td>`).join('')}</tr>`).join(''):`<tr><td class="empty" colspan="${d.table.length}">No authorized records are available yet.</td></tr>`;return `<div class="panel table-wrap"><table class="data-table"><thead><tr>${d.table.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`}function overview(d){const clientPortal=authenticatedClientRoles.has(currentAuthenticatedRole()),primaryContent=d.items.length?list(d.items):`<p class="empty">${escapeHtml(d.emptyMessage||'No authorized records are available yet.')}</p>`,secondaryContent=d.secondaryMessage?`<p class="empty">${escapeHtml(d.secondaryMessage)}</p>`:`${chart()}<p class="eyebrow" style="margin-top:28px">Active placements this week</p>`;return `<div class="card-grid">${d.metrics.map(metricCard).join('')}</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h2 id="detail-title">${d.primary}</h2>${clientPortal?'':'<button class="text-button" id="view-all">View all</button>'}</div><div id="detail-list">${primaryContent}</div></section><section class="panel"><div class="panel-head"><h2>${d.secondary}</h2>${d.secondaryMessage?'':'<button class="text-button">Open report</button>'}</div>${secondaryContent}</section></div>`}
function profilePage(a){if(!a)return `<main class="page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="panel profile-missing"><h1>Talent profile not found</h1><p>This profile may have been removed or you may no longer have access.</p></section></main>`;const contact=[a.email,a.phone].filter(Boolean).join(' · ')||'Contact information not recorded';return `<main class="page talent-profile-page"><button class="text-button back-to-directory">← Back to Talent Directory</button><section class="talent-profile-hero"><div class="headshot-wrap"><div class="talent-headshot" id="talent-headshot"><span>${escapeHtml(initials(a.full_name))}</span></div><label class="button headshot-upload">Upload headshot<input type="file" id="headshot-input" accept="image/jpeg,image/png,image/webp" hidden /></label><small>JPG, PNG, or WebP · up to 5 MB</small></div><div class="profile-identity"><p class="eyebrow">Talent profile</p><h1>${escapeHtml(a.full_name)}</h1><p>${escapeHtml(contact)}</p><div class="profile-tags"><span class="tag">${escapeHtml(titleCase(a.status))}</span><span class="tag neutral">${escapeHtml(titleCase(a.work_status))}</span></div></div><div class="profile-actions"><button class="button" id="profile-add-task">+ Add task</button></div></section><section class="profile-stat-grid"><article><p>Location & time zone</p><strong>${escapeHtml(formatTalentLocationTimeZone(a.location,recordedTalentTimeZone(a)))}</strong></article><article><p>Availability</p><strong>${escapeHtml(a.availability_note||a.dedicated_workspace||'Availability to review')}</strong></article><article><p>Application received</p><strong>${a.application_received_at?escapeHtml(new Date(a.application_received_at).toLocaleDateString()):'Not recorded'}</strong></article><article><p>Profile owner</p><strong>${a.talent_review_owner_id?'Assigned':'Unassigned'}</strong></article></section><div class="profile-layout"><section class="panel profile-section"><div class="panel-head"><div><p class="eyebrow">At a glance</p><h2>Profile details</h2></div></div><dl class="profile-details"><div><dt>Work status</dt><dd>${escapeHtml(titleCase(a.work_status))}</dd></div><div><dt>Expected rate</dt><dd>${escapeHtml(a.expected_hourly_rate_text||a.expected_hourly_rate||'Not recorded')}</dd></div><div><dt>English</dt><dd>${escapeHtml(a.english_proficiency||'Not recorded')}</dd></div><div><dt>Equipment</dt><dd>${escapeHtml(a.equipment_summary||'Not recorded')}</dd></div><div><dt>Internet</dt><dd>${escapeHtml(a.internet_summary||'Not recorded')}</dd></div><div><dt>Dream / goal</dt><dd>${escapeHtml(a.greatest_dream||'To be discussed in the Talent interview')}</dd></div></dl></section><section class="panel profile-section profile-documents-section"><div class="panel-head"><div><p class="eyebrow">Private files</p><h2>Documents & assessments</h2></div><span class="tag">Secure</span></div><div id="profile-documents"><p class="eyebrow">Loading documents…</p></div></section></div></main>`}
function render(){
  if(!viewAllowedForAuthenticatedRole(current)){
    const allowed=authenticatedEmployeeViews[currentAuthenticatedRole()];
    if(!allowed?.has('overview')){root.replaceChildren();return}
    current='overview';selectedTalentId=null;
    history.replaceState({},'',`${location.pathname}#overview`);
    setActive();
  }
  if(current!=='client-talent-profile')window.SoroClientTalentProfile?.unmount?.();
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
    window.SoroClientTalentProfile.mount(root);
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
  if(current==='talent-profile'){
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
  const standardHeadingActions=`${managementTimeOffAction}<button class="button primary" id="add-task">${primaryAction}</button>${current==='overview'||current==='clients'?`<button class="button" id="new-record">+ ${newAction}</button>`:''}${importAction}<button class="button">Customize</button>`;
  const talentPortalActions=`${talentWorkdayAction}${talentTimeOffAction}`;
  const headingActions=clientPortal||role==='va'
    ? (talentPortalActions?`<div class="heading-actions">${talentPortalActions}</div>`:'')
    : `<div class="heading-actions">${standardHeadingActions}</div>`;
  root.innerHTML=`<main class="page"><div class="page-heading"><div><p class="eyebrow">${clientPortal?'Client Portal':'Soro Operations'}</p><h1>${d.title}</h1><p class="eyebrow" style="margin-top:9px">${d.caption}</p></div>${headingActions}</div>${current==='overview'?overview(d):current==='vas'?talentDirectory():table(d)}</main>`;
  bindView();
}
function bindView(){window.soroTalentWorkday?.bindDashboardAction(root);window.soroActiveTalentToday?.bindDashboardMetric(root,{currentView:current,actualRole:actualAuthenticatedRole()});window.soroTalentTimeOff?.bindDashboardActions(root,{currentView:current,actualRole:actualAuthenticatedRole()});document.getElementById('add-task')?.addEventListener('click',()=>{if(role==='client')toast('Your hiring request form is the next portal step.');else document.getElementById('task-dialog').showModal()});document.getElementById('new-record')?.addEventListener('click',()=>toast(`${role==='talent'?'New Talent':role==='client'?'Request another Talent':'New Client'} form is the next build step.`));document.getElementById('import-drive')?.addEventListener('click',importDriveFiles);document.getElementById('talent-search')?.addEventListener('input',e=>{talentSearch=e.target.value;render();document.getElementById('talent-search')?.focus()});document.getElementById('talent-status-filter')?.addEventListener('change',e=>{talentStatus=e.target.value;render()});document.querySelectorAll('.talent-row').forEach(row=>{const open=()=>openTalentProfile(row.dataset.talentId);row.addEventListener('click',open);row.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}})});document.querySelectorAll('.back-to-directory').forEach(b=>b.addEventListener('click',goToTalentDirectory));document.getElementById('profile-add-task')?.addEventListener('click',()=>document.getElementById('task-dialog').showModal());document.getElementById('headshot-input')?.addEventListener('change',e=>uploadHeadshot(e.target.files?.[0]));document.querySelectorAll('[data-metric]').forEach(el=>el.addEventListener('click',()=>{const dashboard=viewDataForAuthenticatedRole('overview',role==='admin'?data.overview:roleDashboards[role]),m=dashboard.metrics[+el.dataset.metric];document.getElementById('detail-title').textContent=m[0];document.getElementById('detail-list').innerHTML=authenticatedClientRoles.has(currentAuthenticatedRole())?`<p class="empty">${escapeHtml(m[2])}</p>`:list([['red',m[2],'Open the detailed queue to continue','Action needed'],['','View recent activity','All related changes are logged','History']])}));document.getElementById('view-all')?.addEventListener('click',()=>{current='tasks';setActive();render()})}
function setActive(){
  const active=current==='talent-profile'?'vas':current;
  document.querySelectorAll('.nav-link').forEach(x=>x.classList.toggle('active',x.dataset.view===active));
  const profileButton=document.getElementById('role-switcher');
  if(profileButton?.dataset.accountAction==='my-profile')profileButton.classList.toggle('active',current==='my-profile');
  const mobileProfile=document.getElementById('client-mobile-profile');
  if(mobileProfile)mobileProfile.setAttribute('aria-current',current==='my-profile'?'page':'false');
}
function goToMyProfile(){if(!viewAllowedForAuthenticatedRole('my-profile'))return;current='my-profile';selectedTalentId=null;history.pushState({},'',`${location.pathname}#my-profile`);setActive();render();document.querySelector('.sidebar')?.classList.remove('open')}
function goToClientTalentProfile(){if(!viewAllowedForAuthenticatedRole('client-talent-profile'))return;current='client-talent-profile';selectedTalentId=null;history.pushState({},'',`${location.pathname}#client-talent-profile`);setActive();render();document.querySelector('.sidebar')?.classList.remove('open')}
function goToTalentDirectory(){if(!viewAllowedForAuthenticatedRole('vas'))return;current='vas';selectedTalentId=null;history.pushState({},'',`${location.pathname}#talent`);setActive();render()}
function openTalentProfile(id){if(!viewAllowedForAuthenticatedRole('talent-profile'))return;selectedTalentId=id;current='talent-profile';history.pushState({talentId:id},'',`${location.pathname}#talent/${id}`);setActive();render()}
nav.addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b||!viewAllowedForAuthenticatedRole(b.dataset.view))return;current=b.dataset.view;selectedTalentId=null;history.pushState({},'',`${location.pathname}#${current}`);setActive();render();document.querySelector('.sidebar').classList.remove('open')});window.addEventListener('popstate',()=>{const m=location.hash.match(/^#talent\/([^/]+)$/);if(m){selectedTalentId=m[1];current='talent-profile'}else{current=location.hash.slice(1)||'overview';selectedTalentId=null}if(!viewAllowedForAuthenticatedRole(current)){current='overview';selectedTalentId=null;history.replaceState({},'',`${location.pathname}#overview`)}setActive();render()});document.getElementById('mobile-menu').addEventListener('click',()=>document.querySelector('.sidebar').classList.toggle('open'));document.getElementById('client-mobile-profile')?.addEventListener('click',goToMyProfile);document.getElementById('task-dialog').addEventListener('close',e=>{if(e.target.returnValue==='default'&&document.getElementById('task-name').value)toast('Task added to My Tasks.');e.target.querySelector('form').reset()});document.querySelectorAll('dialog').forEach(dialog=>{dialog.addEventListener('click',event=>{if(event.target===dialog)dialog.close('cancel')});dialog.querySelector('.modal-close')?.addEventListener('click',()=>dialog.close('cancel'));dialog.querySelector('.modal-cancel')?.addEventListener('click',()=>dialog.close('cancel'))});
function applyRole(nextRole){
  if(actualAuthenticatedRole()!=='admin'||!roleConfig[nextRole])return;
  role=nextRole;
  current='overview';
  selectedTalentId=null;
  const c=roleConfig[role];
  document.getElementById('role-label').textContent=c.label;
  document.querySelector('.profile strong').textContent=c.person;
  document.body.className=c.className;
  history.replaceState({},'',`${location.pathname}#overview`);
  syncAuthorizedNavigation();
  render();
  const workspaceName={admin:'Admin Panel',sales:'Sales Panel',talent:'Talent Management Panel',client:'Client Portal',va:'Talent Portal'}[role];
  toast(`${workspaceName} preview is active.`);
}
document.getElementById('role-switcher').addEventListener('click',event=>{if(event.currentTarget.dataset.accountAction==='my-profile'){goToMyProfile();return}if(event.currentTarget.dataset.accountAction==='workspace-preview'||actualAuthenticatedRole()==='admin')document.getElementById('role-dialog').showModal()});document.getElementById('role-dialog').addEventListener('close',e=>{if(roleConfig[e.target.returnValue])applyRole(e.target.returnValue)});document.getElementById('global-search').addEventListener('keydown',e=>{if(e.key!=='Enter')return;if(authenticatedClientRoles.has(currentAuthenticatedRole())){if(!viewAllowedForAuthenticatedRole(current)){current='overview';history.replaceState({},'',`${location.pathname}#overview`);setActive();render()}toast('Client Portal search is not connected yet.');e.target.blur();return}if(viewAllowedForAuthenticatedRole('vas')){talentSearch=e.target.value;current='vas'}else if(viewAllowedForAuthenticatedRole('clients'))current='clients';else current='overview';setActive();render();e.target.blur()});
async function loadLiveApplicants(){if(!window.soroSupabase||!viewAllowedForAuthenticatedRole('vas')){liveApplicants=[];return}const {data:applicants,error}=await window.soroSupabase.from('applicants').select(talentProfileSelectFields).is('archived_at',null).order('application_received_at',{ascending:false});if(error){liveApplicants=[];return}liveApplicants=applicants||[];if(current==='vas'||current==='talent-profile')render()}
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
async function openPrivateDocument(storagePath){const viewer=window.open('','_blank');if(!viewer){toast('Allow pop-ups for Soro to view private documents.');return}viewer.document.title='Opening secure Soro document…';const {data,error}=await window.soroSupabase.storage.from('soro-private-documents').createSignedUrl(storagePath,60);if(error||!data?.signedUrl){viewer.close();toast('This private document could not be opened.');return}viewer.location.href=data.signedUrl}
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
window.addEventListener('soro-auth-changed',event=>{
  syncAuthorizedNavigation(event.detail.access);
  if(event.detail.session&&viewAllowedForAuthenticatedRole('vas'))loadLiveApplicants();else liveApplicants=[];
  if(event.detail.session&&actualAuthenticatedRole(event.detail.access)==='virtual_assistant')loadOwnTalentProfile();
  else{ownTalentProfileRequest+=1;ownTalentProfile=null;ownTalentProfileState='idle'}
  render();
});
const initialHash=location.hash.match(/^#talent\/([^/]+)$/);
if(initialHash){current='talent-profile';selectedTalentId=initialHash[1]}
else if(location.hash.slice(1) in data||['my-profile','client-talent-profile','talent-my-profile'].includes(location.hash.slice(1))){current=location.hash.slice(1)}
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
