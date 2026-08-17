const data={
  overview:{title:'Admin Panel',caption:'Good afternoon, Matt. Here is what needs your attention.',metrics:[['Tasks needing attention','5','2 overdue','alert'],['Client pipeline','18','4 ready for matching',''],['Active Virtual Assistants today','24','22 checked in',''],['Billing review','3','1 due this week','warning']],primary:'Priority work',items:[['red','Review missing client agreement','Haven & Co. · placement begins Monday','Today'],['','Approve 2 time-off requests','Talent Management · 2 Virtual Assistants','Today'],['','Follow up on payout verification','Finance · 1 Wise recipient','Tomorrow']],secondary:'Soro at a glance'},
  tasks:{title:'My Tasks',caption:'Your active work, in priority order.',table:['Task','Related to','Due','Owner'],rows:[['Review missing client agreement','Haven & Co.','Today','Matt Johnson'],['Approve time-off request','Mariel Santos','Today','Talent Management'],['Update client discovery','Northstar Legal','Tomorrow','Matt Johnson'],['Review payout exception','Daniel Cruz','Friday','Billing']]},
  clients:{title:'Client Pipeline',caption:'Every client, lead, and next action in one place.',table:['Client','Stage','Next action','Owner'],rows:[['Haven & Co.','Placement onboarding','Sign agreement','Morgan Lee'],['Northstar Legal','Discovery','Complete required checklist','Matt Johnson'],['Brightlane Medical','Ready for matching','Build shortlist','Morgan Lee'],['Urban Ledger','New inquiry','Claim or assign','Unassigned']]},
  vas:{title:'Talent Directory',caption:'Search, filter, and classify every applicant and Talent profile.',table:['Talent','Application status','Current work status','Owner'],rows:[]},
  placements:{title:'Placement Journey',caption:'Client and VA readiness, side by side.',table:['Client','VA','Status','Next action'],rows:[['Haven & Co.','Mariel Santos','Onboarding','Client agreement'],['Brightlane Medical','Arielle Tan','Interviewing','Confirm interview'],['Urban Ledger','—','Discovery','Complete role requirements']]},
  documents:{title:'Document Center',caption:'Assigned forms, uploads, and signed agreements.',table:['Document','Related to','Status','Action'],rows:[['Soro client agreement','Haven & Co.','Awaiting signature','Send reminder'],['Contractor agreement','Mariel Santos','Signed','View'],['HIPAA acknowledgment','Brightlane Medical','Needs review','Review upload']]},
  reports:{title:'Reports',caption:'Saved reports and quick builds, only for data you are authorized to see.',table:['Report','Last run','Owner','Action'],rows:[['Sales Pipeline Health','Today','Sales Management','Open'],['Active VA Attendance','Today','Talent Management','Open'],['Payout History','Aug 14','Billing','Open'],['Client Feedback Trends','Aug 12','Admin','Open']]}
};
let current='overview';
let role='admin';
let liveApplicantRows=[];
let liveApplicants=[];
const roleConfig={admin:{label:'Administrator',person:'Matt Johnson',className:'role-admin'},sales:{label:'Sales',person:'Morgan Lee',className:'role-sales'},talent:{label:'Talent Management',person:'Jordan Reed',className:'role-talent'},client:{label:'Client Administrator',person:'Avery Parker',className:'role-client'},va:{label:'Virtual Assistant',person:'Mariel Santos',className:'role-va'}};
const roleDashboards={
  sales:{title:'Sales Panel',caption:'Good afternoon, Morgan. Your priority client work is ready.',metrics:[['Tasks needing attention','6','2 overdue','alert'],['My client pipeline','18','4 ready for matching',''],['Open hiring requests','7','3 awaiting shortlist',''],['My available Virtual Assistants','14','6 available now','']],primary:'Priority accounts needing action',items:[['red','Complete discovery for Northstar Legal','Required specialty checklist still has 2 items','Today'],['','Send shortlist to Brightlane Medical','Three selected Virtual Assistants are ready to present','Today'],['','Follow up after client interview','Haven & Co. · Mariel Santos','Tomorrow']],secondary:'Pipeline movement'},
  talent:{title:'Talent Panel',caption:'Good afternoon, Jordan. Here is your Virtual Assistant readiness and support work.',metrics:[['Virtual Assistant actions needing attention','8','3 need follow-up','alert'],['Active Virtual Assistants today','24','22 checked in',''],['Talent Review Queue','12','5 interview ready',''],['Upcoming reviews','4','2 this week','']],primary:'Priority Virtual Assistant support',items:[['red','Check in with Alex Ramos','15 minutes past scheduled start','Now'],['','Review 2 incomplete applications','Video or equipment proof missing','Today'],['','Prepare Mariel’s onboarding session','Placement begins Monday','Tomorrow']],secondary:'Virtual Assistant readiness'},
  client:{title:'Good afternoon, Avery',caption:'Your active VA support and Soro actions are all in one place.',metrics:[['Action needed','2','1 document is awaiting your signature','alert'],['Your current VAs','3','All active placements',''],['Open hiring requests','1','Next review tomorrow',''],['Invoices','1','Due this Friday','warning']],primary:'Action needed',items:[['red','Sign the Soro client agreement','Haven & Co. · secure document ready','Today'],['','Choose interview windows','Operations support role · 3 candidates ready','Tomorrow']],secondary:'Your current VAs'},
  va:{title:'Good afternoon, Mariel',caption:'Your workday, progress, and support are all here.',metrics:[['Today’s work','Active','Checked in at 8:58 AM',''],['Dream Pathway','1 next step','Review education options',''],['Next payout','Friday','Current pay period',''],['Documents','1 action','Update Wise recipient verification','warning']],primary:'Action needed',items:[['','Complete your Dream Pathway action','Choose two education programs to discuss at your next review','This week'],['','Update payout verification','Wise recipient details need confirmation','This week']],secondary:'Your progress'}
};
const root=document.getElementById('view-root');
const nav=document.getElementById('main-nav');
function toast(message){const t=document.createElement('div');t.className='toast';t.textContent=message;document.body.append(t);setTimeout(()=>t.remove(),2800)}
function metricCard(m,i){return `<button class="metric ${m[3]}" data-metric="${i}"><p>${m[0]}</p><strong>${m[1]}</strong><small>${m[2]}</small></button>`}
function list(items){return `<div class="list">${items.map(x=>`<div class="list-item"><span class="status-dot ${x[0]}"></span><span><strong>${x[1]}</strong><small>${x[2]}</small></span><span class="pill">${x[3]}</span></div>`).join('')}</div>`}
function chart(){return `<div class="bar-chart" aria-label="Active placements trend">${[46,62,51,77,66,91,83].map((h,i)=>`<div class="bar" style="height:${h}%"><span>${['M','T','W','T','F','S','S'][i]}</span></div>`).join('')}</div>`}
function escapeHtml(value){return String(value??'').replace(/[&<>'"]/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[character]))}
function table(d){const rows=current==='vas'?liveApplicantRows:d.rows;const body=rows.length?rows.map((r,rowIndex)=>`<tr>${r.map((x,i)=>`<td>${i===0&&current==='vas'?`<button class="text-button talent-profile" data-talent-index="${rowIndex}">${escapeHtml(x)}</button>`:i===1&&['clients','vas'].includes(current)?`<span class="tag">${escapeHtml(x)}</span>`:escapeHtml(x)}</td>`).join('')}</tr>`).join(''):`<tr><td class="empty" colspan="${d.table.length}">No authorized records are available yet.</td></tr>`;return `<div class="panel table-wrap"><table class="data-table"><thead><tr>${d.table.map(x=>`<th>${escapeHtml(x)}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></div>`}
function overview(d){return `<div class="card-grid">${d.metrics.map(metricCard).join('')}</div><div class="dashboard-grid"><section class="panel"><div class="panel-head"><h2 id="detail-title">${d.primary}</h2><button class="text-button" id="view-all">View all</button></div><div id="detail-list">${list(d.items)}</div></section><section class="panel"><div class="panel-head"><h2>${d.secondary}</h2><button class="text-button">Open report</button></div>${chart()}<p class="eyebrow" style="margin-top:28px">Active placements this week</p></section></div>`}
function render(){const d=current==='overview'?(role==='admin'?data.overview:roleDashboards[role]):data[current];const newAction=role==='talent'?'New Talent':role==='client'?'Request Talent':role==='va'?'Start Day':'New Client';const primaryAction=role==='va'?'Start Day':role==='client'?'Request another Talent':'+ Add Task';const importAction=current==='vas'&&role==='admin'?`<button class="button" id="import-drive">Import Drive files</button>`:'';root.innerHTML=`<main class="page"><div class="page-heading"><div><p class="eyebrow">Soro Operations</p><h1>${d.title}</h1><p class="eyebrow" style="margin-top:9px">${d.caption}</p></div><div class="heading-actions"><button class="button primary" id="add-task">${primaryAction}</button>${current==='overview'||current==='clients'?`<button class="button" id="new-record">+ ${newAction}</button>`:''}${importAction}<button class="button">Customize</button></div></div>${current==='overview'?overview(d):table(d)}</main>`;bindView()}
function bindView(){document.getElementById('add-task')?.addEventListener('click',()=>{if(role==='va')toast('Start Day recorded. Your Talent Management team can see you are active.');else if(role==='client')toast('Your hiring request form is the next portal step.');else document.getElementById('task-dialog').showModal()});document.getElementById('new-record')?.addEventListener('click',()=>toast(`${role==='talent'?'New Talent':role==='client'?'Request another Talent':role==='va'?'Time off request':'New Client'} form is the next build step.`));document.getElementById('import-drive')?.addEventListener('click',importDriveFiles);document.querySelectorAll('.talent-profile').forEach(el=>el.addEventListener('click',()=>openTalentProfile(liveApplicants[Number(el.dataset.talentIndex)])));document.querySelectorAll('[data-metric]').forEach(el=>el.addEventListener('click',()=>{const i=+el.dataset.metric;const metric=(role==='admin'?data.overview:roleDashboards[role]).metrics[i];document.getElementById('detail-title').textContent=metric[0];document.getElementById('detail-list').innerHTML=list([['red',metric[2],'Open the detailed queue to continue','Action needed'],['','View recent activity','All related changes are logged','History']])}));document.getElementById('view-all')?.addEventListener('click',()=>{current='tasks';setActive();render()})}
function setActive(){document.querySelectorAll('.nav-link').forEach(x=>x.classList.toggle('active',x.dataset.view===current))}
nav.addEventListener('click',e=>{const b=e.target.closest('[data-view]');if(!b)return;current=b.dataset.view;setActive();render();document.querySelector('.sidebar').classList.remove('open')});
document.getElementById('mobile-menu').addEventListener('click',()=>document.querySelector('.sidebar').classList.toggle('open'));
document.getElementById('task-dialog').addEventListener('close',e=>{if(e.target.returnValue==='default'&&document.getElementById('task-name').value)toast('Task added to My Tasks.');e.target.querySelector('form').reset()});
function applyRole(nextRole){role=nextRole;current='overview';const c=roleConfig[role];document.getElementById('role-label').textContent=c.label;document.querySelector('.profile strong').textContent=c.person;document.body.className=c.className;setActive();render();const name=role==='sales'?'Sales Panel':role==='talent'?'Talent Panel':role==='client'?'Client Portal':role==='va'?'Virtual Assistant Portal':'Admin Panel';toast(`${name} preview is active.`)}
document.getElementById('role-switcher').addEventListener('click',()=>document.getElementById('role-dialog').showModal());
document.getElementById('role-dialog').addEventListener('close',e=>{if(roleConfig[e.target.returnValue])applyRole(e.target.returnValue)});
document.getElementById('global-search').addEventListener('keydown',e=>{if(e.key==='Enter'){toast(`Search for “${e.target.value}” is ready to connect to live records.`);e.target.blur()}});
async function loadLiveApplicants(){
  if(!window.soroSupabase)return;
  const {data:applicants,error}=await window.soroSupabase.from('applicants').select('id,full_name,email,status,work_status,talent_review_owner_id').order('application_received_at',{ascending:false});
  if(error){liveApplicantRows=[];liveApplicants=[];return;}
  liveApplicants=applicants||[];
  liveApplicantRows=(applicants||[]).map(applicant=>[
    applicant.full_name,
    applicant.status.replaceAll('_',' ').replace(/\b\w/g,letter=>letter.toUpperCase()),
    applicant.work_status||'Not yet recorded',
    applicant.talent_review_owner_id?'Assigned':'Unassigned'
  ]);
  if(current==='vas')render();
}
async function openTalentProfile(applicant){
  if(!applicant||!window.soroSupabase)return;
  const dialog=document.getElementById('talent-dialog');
  const title=document.getElementById('talent-profile-title');
  const content=document.getElementById('talent-profile-content');
  title.textContent=applicant.full_name;
  content.innerHTML='<p class="eyebrow">Loading secure Talent documents…</p>';
  dialog.showModal();
  const {data:documents,error}=await window.soroSupabase.from('documents').select('file_name,document_type,status,created_at,storage_path').eq('applicant_id',applicant.id).order('created_at',{ascending:false});
  if(error){content.innerHTML='<p>Documents could not be loaded for this Talent profile.</p>';return;}
  const documentRows=(documents||[]).length?(documents||[]).map(document=>`<li><span><strong>${escapeHtml(document.file_name)}</strong><small>${escapeHtml(document.document_type.replaceAll('_',' '))} · ${escapeHtml(document.status)}</small></span>${document.storage_path?`<button class="text-button open-private-document" data-storage-path="${escapeHtml(document.storage_path)}">Open securely</button>`:'<span class="tag">Private file</span>'}</li>`).join(''):'<li><span><strong>No documents attached yet</strong><small>Imported and uploaded files will appear here.</small></span></li>';
  content.innerHTML=`<p class="eyebrow">Talent profile</p><p>${escapeHtml(applicant.email||'')}</p><section class="profile-documents"><div class="panel-head"><h3>Documents uploaded</h3><span class="tag">Private</span></div><ul>${documentRows}</ul></section>`;
  content.querySelectorAll('.open-private-document').forEach(button=>button.addEventListener('click',()=>openPrivateDocument(button.dataset.storagePath)));
}
async function openPrivateDocument(storagePath){
  const viewer=window.open('','_blank');
  if(!viewer){toast('Allow pop-ups for Soro to view private documents.');return;}
  viewer.document.title='Opening secure Soro document…';
  const {data,error}=await window.soroSupabase.storage.from('soro-private-documents').createSignedUrl(storagePath,60);
  if(error||!data?.signedUrl){viewer.close();toast('This private document could not be opened.');return;}
  viewer.location.href=data.signedUrl;
}
async function importDriveFiles(){
  const button=document.getElementById('import-drive');
  if(!button)return;
  button.disabled=true;button.textContent='Starting import…';
  toast('Checking your Admin access and preparing the secure import…');
  try{
    if(!window.soroSupabase)throw new Error('Soro sign-in is still loading. Refresh this page and try again.');
    // Supabase refreshes its current session automatically when needed. Using
    // the session already active in the app avoids a silent refresh failure
    // before the Import button can report its status.
    const {data:{session},error:sessionError}=await window.soroSupabase.auth.getSession();
    if(sessionError||!session)throw new Error('Please sign in to Soro again, then retry the import.');
    let offset=0,imported=0,skipped=0,total=0;
    do{
      button.textContent=total?`Importing ${Math.min(offset+1,total)}/${total}…`:'Importing…';
      const response=await fetch('/.netlify/functions/import-google-drive',{method:'POST',headers:{Authorization:`Bearer ${session.access_token}`,'Content-Type':'application/json'},body:JSON.stringify({offset})});
      const responseText=await response.text();
      let report;
      try{report=JSON.parse(responseText);}catch{throw new Error(`The import server returned an unexpected response (${response.status}).`);}
      if(!response.ok)throw new Error(report.error||'The import could not start.');
      imported+=report.imported||0;skipped+=report.skipped||0;total=report.total||0;offset=report.nextOffset;
      if(report.complete)break;
    }while(offset<total);
    toast(`${imported} private files attached. ${skipped} already existed.`);
    await loadLiveApplicants();
  }catch(error){toast(error.message||'The import could not start.');}
  finally{button.disabled=false;button.textContent='Import Drive files';}
}
document.getElementById('close-talent-profile').addEventListener('click',()=>document.getElementById('talent-dialog').close());
window.addEventListener('soro-auth-changed',event=>{if(event.detail.session)loadLiveApplicants();else liveApplicantRows=[];});
render();
