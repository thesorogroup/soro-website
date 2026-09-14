/* Runs only in an opaque sandbox. All state is fictional and is discarded on exit. */
(function(w){
  'use strict';
  if(w.parent===w)return;
  const id=n=>`f0000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  const clone=v=>JSON.parse(JSON.stringify(v));
  const now=()=>new Date().toISOString();
  const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Manila',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const validCalendarDate=value=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const parsed=new Date(value+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;};
  const personas={client:{role:'client_admin',name:'Alex Carter',id:id(1)},talent:{role:'talent_management',name:'Taylor Morgan',id:id(2)},sales:{role:'sales',name:'Jordan Lee',id:id(3)},va:{role:'virtual_assistant',name:'Jamie Cruz',id:id(4)}};
  let selected='client',store;
  const localFiles=new Map();
  function reset(){
    for(const file of localFiles.values())if(file.url)URL.revokeObjectURL(file.url);
    localFiles.clear();
    store={contactName:'Alex Carter',companyName:'Sample Company',tasks:[],stage:'submitted',recorded:false,verified:[],workday:'not_started'};
    store.applicants=[{id:id(10),organization_id:id(90),auth_user_id:id(4),full_name:'Cruz, Jamie',first_name:'Jamie',last_name:'Cruz',preferred_name:'Jamie',email:'jamie@example.test',phone:'',application_status:'submitted',review_status:'submitted',application_received_at:now(),created_at:now(),updated_at:now(),archived_at:null,country:'Philippines',time_zone:'Asia/Manila',current_work_status:'Available',availability:'Full time',skills:['Calendar management','Email management','Medical coding'],verified_skills:[],work_areas:['General Virtual Assistance','Medical & Healthcare'],experience_years:3,experience_summary:'Fictional profile for reviewing the current Talent Portal.',greatest_dream:'I want to finish my education and build a stable future for my family. Being able to learn, grow, and be present for the people I love is what makes the journey meaningful to me.',english_test_result:'',personality_test_result:'',computer_specifications:'',internet_speed:'',review_owner_id:id(2)}];
    store.applicants[0].self_reported_skills=store.applicants[0].skills.slice();
    Object.assign(store.applicants[0],{status:'submitted',work_status:'Available',timezone:'Asia/Manila',english_proficiency_score:'',personality_profile_score:'',computer_specs:'',legacy_application_data:{}});
    store.applicants[0].verified_skills=['Calendar management','Email management'];
    store.applicants.push({...clone(store.applicants[0]),id:id(11),auth_user_id:null,full_name:'Santos, Riley',first_name:'Riley',last_name:'Santos',preferred_name:'Riley',email:'riley@example.test',phone:'',verified_skills:[]});
    for(const a of store.applicants)Object.assign(a,{relevant_experience_years:a.experience_years,relevant_experience_summary:a.experience_summary,education_training_summary:'Business administration coursework and virtual assistance training.',self_reported_experience_areas:a.work_areas.slice(),availability_note:'Full time · Monday–Friday',address_line_1:'100 Sample Street',city:'Cebu City',province_state:'Cebu',postal_code:'6000',portal_access_status:a.auth_user_id?'active':'not_activated'});
    store.documents=[];store.uploads=[];store.reviewDeferrals={};store.reviewDeferralRequests={};store.reviewDeferralTaskIds={};store.taskNotifications=[];
    store.classificationRequests={};store.classificationAudit=[];
    // A private fictional legacy file makes classification reviewable without live data.
    store.documents.push({id:id(80),applicant_id:id(11),organization_id:id(90),file_name:'Sample personality assessment.svg',document_type:'assessment',status:'uploaded',storage_path:'samples/'+id(11)+'/personality-assessment.svg',external_url:null,created_at:now(),updated_at:now()});
    const sampleAssessmentUrl='data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="500"><rect width="600" height="500" fill="#f3f7fc"/><text x="40" y="65" font-family="sans-serif" font-size="22" fill="#12385c">FICTIONAL TEST FILE</text><text x="40" y="130" font-family="sans-serif" font-size="28" fill="#12385c">DISC Assessment</text><text x="40" y="190" font-family="sans-serif" font-size="20" fill="#12385c">Sample Talent: Riley Santos</text><text x="40" y="250" font-family="sans-serif" font-size="20" fill="#12385c">D: 24   I: 31   S: 27   C: 18</text><text x="40" y="335" font-family="sans-serif" font-size="16" fill="#486780">For testing file classification only.</text><text x="40" y="365" font-family="sans-serif" font-size="16" fill="#486780">Not a real assessment or score record.</text></svg>');
    localFiles.set(store.documents[0].storage_path,{url:sampleAssessmentUrl});
    store.interview=null;store.interviewHistory=[];store.interviewRequests={};store.interviewAudit=[];
    store.clients=[{id:id(50),company:{name:store.companyName,industry:'Professional services',website:'example.test',country:'United States'},primaryContact:{name:store.contactName,title:'Owner',email:'alex@example.test',phone:''},owner:{id:id(3),name:'Jordan Lee',current:true},lifecycleStage:'active',portal:{requested:true,status:'active',email:'alex@example.test'},hiringRequests:[{id:id(20),roleTitle:'General Virtual Assistant',vaType:'General',seats:1,skills:['Calendar management','Email management'],schedule:'Monday–Friday · Philippine Time',timeZone:'Asia/Manila',targetStartDate:day(),status:'filled',progressStep:'active',candidateCount:0}],activity:[{label:'Sample account',detail:'Fictional data for Test Mode.',timestamp:now()}]}];
    store.tasks=[{id:id(30),title:'Review your sample profile',details:'Check your details and let your Soro team know if anything needs updating. This is a fictional task.',kind:'manual',version:1,progress:'not_started',status:'open',priority:'normal',dueDate:day(),createdAt:now(),updatedAt:now(),relatedLabel:'Sample Talent Profile',isUnread:true,assignees:[{id:id(4),userId:id(4),name:'Jamie Cruz'}],assignedTo:{id:id(4),name:'Jamie Cruz'},createdBy:{id:id(2),name:'Taylor Morgan'},history:[]}];
    store.tasks.push({...clone(store.tasks[0]),id:id(31),title:'Review client requirements',details:'Check the sample Client account and its role requirements.',relatedLabel:'Sample Company',assignees:[{id:id(3),userId:id(3),name:'Jordan Lee'}],assignedTo:{id:id(3),name:'Jordan Lee'},createdBy:{id:id(3),name:'Jordan Lee'}});
  }
  reset();
  const notice=message=>w.parent.postMessage({type:'soro-test-notice',message},'*');
  const unavailable=()=>{notice('This action is not available in Test Mode. No live request was sent.');return{error:{message:'Not available in Test Mode. No live request was sent.'},data:null};};
  function access(){const p=personas[selected];return{role:p.role,display_name:p.name,user_id:p.id,id:p.id,organization_id:id(90),active:true,is_founder:false,must_change_password:false};}
  const personaEmail=()=>({client:'alex@example.test',talent:'taylor@example.test',sales:'jordan@example.test',va:'jamie@example.test'})[selected];
  const canReadFiles=a=>!!a&&(selected==='talent'||selected==='va'&&a.auth_user_id===personas.va.id);
  function tableRows(table){
    const a=store.applicants[0],client={id:id(50),company_name:store.companyName,industry:'Professional services',lifecycle_stage:'active'};
    if(table==='applicants')return selected==='client'?[]:selected==='va'?[a]:store.applicants;
    if(table==='documents')return store.documents.filter(d=>canReadFiles(store.applicants.find(a=>a.id===d.applicant_id)));
    if(table==='platform_users')return Object.values(personas).map(p=>({id:p.id,user_id:p.id,organization_id:id(90),display_name:p.name,email:p.name.split(' ')[0].toLowerCase()+'@example.test',role:p.role,active:true}));
    if(table==='placements')return[{id:id(21),applicant_id:a.id,client_id:client.id,status:'active',start_date:a.created_at.slice(0,10),end_date:null,schedule_summary:'Monday–Friday · 9 AM–5 PM Philippine Time',rate_type:'hourly',clients:client,client}];
    if(table==='talent_attendance_sessions')return store.workday==='not_started'?[]:[{id:id(22),applicant_id:a.id,placement_id:id(21),work_date:store.workDate,work_timezone:'Asia/Manila',started_at:store.startedAt,checked_out_at:store.checkedOutAt||null}];
    return [];
  }
  function query(table){
    const filters=[],orders=[];let single=false,mutation=null,maximum=Infinity,offset=0;
    const captured=store,actor=selected;
    const api={select(){return api;},eq(k,v){filters.push(r=>r[k]===v);return api;},neq(k,v){filters.push(r=>r[k]!==v);return api;},not(k,op,v){if(op==='is')filters.push(r=>(r[k]??null)!==v);return api;},is(k,v){filters.push(r=>(r[k]??null)===v);return api;},in(k,v){filters.push(r=>v.includes(r[k]));return api;},order(k,o={}){orders.push([k,o.ascending!==false]);return api;},limit(n){maximum=n;return api;},range(start,end){offset=start;maximum=end-start+1;return api;},maybeSingle(){single=true;return api;},single(){single=true;return api;},update(v){mutation=v;return api;},insert(){mutation=false;return api;},delete(){mutation=false;return api;},then(resolve,reject){try{if(captured!==store||actor!==selected)return Promise.resolve(unavailable()).then(resolve,reject);let rows=tableRows(table).filter(row=>filters.every(f=>f(row)));if(mutation!==null){if(table!=='applicants'||selected!=='talent'||!mutation)return Promise.resolve(unavailable()).then(resolve,reject);rows.forEach(row=>Object.assign(row,mutation,{updated_at:new Date(Math.max(Date.now(),Date.parse(row.updated_at)+1)).toISOString()}));if(rows.length)notice('Sample profile updated in this test session only.');}rows=rows.slice().sort((a,b)=>{for(const[k,asc]of orders){if(a[k]!==b[k])return(a[k]<b[k]?-1:1)*(asc?1:-1);}return 0;}).slice(offset,offset+maximum);return Promise.resolve({data:clone(single?(rows[0]||null):rows),error:null}).then(resolve,reject);}catch(e){return Promise.reject(e).then(resolve,reject);}}};return api;
  }
  w.SORO_SUPABASE_CONFIG=Object.freeze({url:'https://test.invalid'});
  w.soroSupabase={auth:{getSession:async()=>({data:{session:{access_token:'fictional-test-session',user:{id:personas[selected].id,email:personaEmail()}}}}),getUser:async()=>({data:{user:{id:personas[selected].id,email:personaEmail()}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:query,rpc:async()=>unavailable(),storage:{from:bucket=>({createSignedUrl:async path=>{const d=tableRows('documents').find(d=>d.storage_path===path),file=localFiles.get(path);return bucket==='soro-private-documents'&&d&&file?.url?{data:{signedUrl:file.url},error:null}:unavailable();},upload:async()=>unavailable(),download:async()=>unavailable()})}};
  w.soroCurrentAccess=access();
  // The parent URL and browser history are never changed by sample navigation.
  let routeState=null;
  const nativeReplace=w.history.replaceState.bind(w.history);
  for(const method of ['replaceState','pushState'])w.history[method]=(state,title,url)=>{routeState=state;const hash=String(url||'').includes('#')?'#'+String(url).split('#').slice(1).join('#'):'';nativeReplace(state,title,'about:srcdoc'+hash);};
  try{Object.defineProperty(w.history,'state',{get:()=>routeState});}catch{}
  function dashboard(){return{generatedAt:now(),viewerRole:personas[selected].role,companyName:store.companyName,contactName:store.contactName,salesContact:{name:'Jordan Lee',email:'jordan@example.test',phone:''},requests:[{requestId:id(20),roleTitle:'General Virtual Assistant',status:'filled',targetStartDate:day(),seatCount:1,candidateCount:0,pendingReviewCount:0,pendingDecisionCount:0,placementCount:1,activePlacementCount:1,onboardingCount:0}],interviews:[],talent:[{placementId:id(21),applicantId:id(10),fullName:'Jamie Cruz',preferredName:'Jamie',roleTitle:'General Virtual Assistant',status:'active',startDate:day(),scheduleSummary:'Monday–Friday · 9 AM–5 PM Philippine Time'}]};}
  function queue(){
    const a=store.applicants[1],keys=['core_profile','resume','english','disc','enneagram','mbti','internet','equipment','skills'],labels=['Core profile','Resume','English assessment','DISC assessment','Enneagram assessment','Four-letter personality assessment','Internet speed proof','Computer specifications','Skills'];
    const personality=w.soroScreeningPresentation?.parsePersonalityResults(a.personality_profile_score)||{};
    const values={english:a.english_test_result,disc:personality.disc,enneagram:personality.enneagram,mbti:personality.mbti,internet:a.internet_speed,equipment:a.computer_specs};
    const nonblank=value=>typeof value==='string'&&!!value.trim();
    const coreComplete=['full_name','email','phone','timezone'].every(field=>nonblank(a[field]))&&(nonblank(a.location)||nonblank(a.country)&&nonblank(a.city));
    const checklist=keys.map((key,i)=>{
      const evidenceTypes={english:'english_proof',disc:'disc_assessment',enneagram:'enneagram_assessment',mbti:'mbti_assessment',internet:'internet_proof',equipment:'equipment_proof'};
      const files=store.documents.filter(d=>d.applicant_id===a.id&&d.status!=='rejected');
      const fileAvailable=files.some(d=>d.document_type===evidenceTypes[key]);
      const unclassified=['disc','enneagram','mbti'].includes(key)&&files.some(d=>d.document_type==='assessment');
      const state=i>=2&&i<=7?(fileAvailable?'complete':values[key]?'needs_review':'missing'):key==='resume'||key==='core_profile'&&!coreComplete?'missing':key==='skills'&&![...(a.self_reported_skills||[]),...(a.self_reported_experience_areas||[]),...(a.verified_skills||[])].some(x=>String(x).trim())?'missing':'complete';
      const deferral=state!=='complete'?store.reviewDeferrals[key]:null;
      if(state==='complete')delete store.reviewDeferrals[key];
      return{key,label:labels[i],state,...(i>=2&&i<=7?{resultRecorded:Boolean(values[key]),evidenceState:fileAvailable?'available':unclassified?'unclassified_available':'missing'}:{}),...(key==='skills'?{verifiedSkillsCount:a.verified_skills.length}:{}),...(deferral?{deferral:clone(deferral)}:{})};
    });
    return{generatedAt:now(),viewerRole:personas[selected].role,summary:{all:1,submitted:store.stage==='submitted'?1:0,in_review:store.stage==='in_review'?1:0,needs_more_info:store.stage==='needs_more_info'?1:0,bench_ready:store.stage==='bench_ready'?1:0,closed:0},applicants:[{applicantId:a.id,fullName:a.full_name,email:a.email,applicationReceivedAt:a.application_received_at,updatedAt:a.updated_at,stage:store.stage,archived:false,owner:{id:id(2),name:'Taylor Morgan'},resume:{available:false,label:'No sample résumé'},checklist,allowedActions:store.stage==='submitted'?['begin_review']:store.stage==='bench_ready'?['return_to_review']:['request_more_info','mark_bench_ready']}]};
  }
  function reviewRequirements(){
    const a=queue().applicants[0];
    if(interviewAddressed())delete store.reviewDeferrals.interview;
    return{applicantId:a.applicantId,updatedAt:a.updatedAt,items:[...a.checklist.map(item=>({key:item.key,label:item.label,status:item.deferral?'deferred':item.state==='complete'?'complete':'pending',deferral:item.deferral||null})),...['interview','references'].map(key=>({key,label:key==='interview'?'Interview':'Employment references',status:key==='interview'&&interviewAddressed()?'complete':store.reviewDeferrals[key]?'deferred':'pending',deferral:store.reviewDeferrals[key]||null}))]};
  }
  const interviewAddressed=()=>!!store.interview&&(store.interview.status==='completed'&&!!store.interview.outcome||['no_show','waived'].includes(store.interview.status)&&!!store.interview.notes?.trim());
  function reviewGate(){
    const items=reviewRequirements().items.filter(i=>['interview','references'].includes(i.key));
    return{interviewAddressed:interviewAddressed(),referencesAddressed:false,benchReadyEligible:items.every(i=>i.status!=='pending'),blockers:items.filter(i=>i.status==='pending').map(i=>i.label+' must be addressed'),deferrals:{interview:store.reviewDeferrals.interview||null,references:store.reviewDeferrals.references||null}};
  }
  function verification(){return{generatedAt:now(),viewerRole:personas[selected].role,applicant:queue().applicants[0],gate:reviewGate(),interview:clone(store.interview),interviewHistory:clone(store.interviewHistory),references:[],interviewers:[{id:id(2),name:'Taylor Morgan'}],availableAttendees:[{id:id(3),name:'Jordan Lee'}],calendarIntegration:{configured:false,organizerLabel:'Disabled in Test Mode'}};}
  function recordPreviousInterview(body){
    const keys=['action','requestId','applicantId','expectedUpdatedAt','interviewId','occurredOn','interviewerName','outcome','communicationScore','preparednessScore','roleFitScore','overallScore','note'];
    const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    const validText=(value,max)=>typeof value==='string'&&!!value.trim()&&value.trim().length<=max&&!value.includes('\u0000');
    if(Object.keys(body).length!==keys.length||keys.some(k=>!Object.hasOwn(body,k))||body.action!=='record_previous_interview'||!uuid(body.requestId)||body.applicantId!==id(11)||!['admin','talent_management'].includes(personas[selected].role))return null;
    const fingerprint=JSON.stringify(body),prior=store.interviewRequests[body.requestId];
    if(prior)return prior===fingerprint?verification():null;
    if(!['in_review','needs_more_info','bench_ready'].includes(store.stage)||store.applicants[1].archived_at)return null;
    if(!validText(body.interviewerName,180)||!validText(body.note,4000)||!['recommended','follow_up','not_recommended'].includes(body.outcome))return null;
    if(body.occurredOn!==null&&(!validCalendarDate(body.occurredOn)||body.occurredOn>new Date().toISOString().slice(0,10)))return null;
    const scores=['communicationScore','preparednessScore','roleFitScore','overallScore'];
    if(scores.some(k=>body[k]!==null&&(!Number.isInteger(body[k])||body[k]<1||body[k]>5)))return null;
    const current=store.interview;
    if(current){
      if(body.interviewId!==current.interviewId||body.expectedUpdatedAt!==current.updatedAt)return null;
      if(current.recordSource!=='historical'&&!(current.status==='cancelled'&&current.calendar.status==='not_applicable'))return null;
    }else if(body.interviewId!==null||body.expectedUpdatedAt!==null)return null;
    const stamp=new Date(Math.max(Date.now(),Date.parse(current?.updatedAt||0)+1)).toISOString();
    if(current&&current.recordSource!=='historical')store.interviewHistory.push(clone(current));
    const next={interviewId:current?.interviewId||crypto.randomUUID(),roundNumber:(current?.roundNumber||1)+(current&&current.recordSource!=='historical'?1:0),recordSource:'historical',occurredOn:body.occurredOn,status:'completed',startsAt:null,endsAt:null,timezone:null,updatedAt:stamp,interviewer:{id:null,name:body.interviewerName.trim()},additionalAttendees:[],outcome:body.outcome,scorecard:{communication:body.communicationScore,preparedness:body.preparednessScore,roleFit:body.roleFitScore,overall:body.overallScore},notes:body.note.trim(),calendar:{status:'not_applicable',joinUrl:null}};
    store.interviewAudit.push({actorId:personas[selected].id,at:stamp,action:'record_previous_interview',before:clone(current),after:clone(next)});
    store.interview=next;store.applicants[1].updated_at=stamp;store.interviewRequests[body.requestId]=fingerprint;
    notice('Previous interview saved in this test session only. No invitation, email, or task was created.');
    return verification();
  }
  function changeReviewDeferral(body){
    const a=store.applicants[1],item=reviewRequirements().items.find(i=>i.key===body.itemKey);
    if(selected!=='talent'||body.applicantId!==a.id||!item||!['defer','restore'].includes(body.action)||!String(body.reason||'').trim()||body.reason.length>500)return null;
    const fingerprint=JSON.stringify(body),prior=store.reviewDeferralRequests[body.requestId];
    if(prior)return prior===fingerprint?queue():null;
    if(a.updated_at!==body.expectedUpdatedAt||!['in_review','needs_more_info','bench_ready'].includes(store.stage)||item.status==='complete')return null;
    if(body.action==='restore'){
      if(!store.reviewDeferrals[item.key]||body.createTask||body.dueDate)return null;
      delete store.reviewDeferrals[item.key];
      if(store.stage==='bench_ready')store.stage='in_review';
    }else{
      if(item.status==='deferred'||typeof body.createTask!=='boolean'||(body.createTask?!validCalendarDate(body.dueDate):body.dueDate!==null))return null;
      const taskId=body.createTask?crypto.randomUUID():null,stamp=now(),person=personas.talent;
      store.reviewDeferrals[item.key]={id:crypto.randomUUID(),reason:body.reason.trim(),createdAt:stamp,createdByName:person.name,dueDate:body.dueDate,taskId};
      if(taskId){
        // Retain this audience restriction after the active deferral is closed.
        store.reviewDeferralTaskIds[taskId]=true;
        const title='Complete deferred review: '+item.label;
        store.tasks.push({id:taskId,title,details:'Open Talent Review for '+a.full_name+' and complete '+item.label+'. Reason for deferral: '+body.reason.trim()+'\nCompleting this reminder does not verify the requirement.',kind:'manual',version:1,progress:'not_started',status:'open',priority:'normal',dueDate:body.dueDate,createdAt:stamp,updatedAt:stamp,relatedLabel:a.full_name,isUnread:true,assignees:[{id:person.id,userId:person.id,name:person.name}],assignedTo:{id:person.id,name:person.name},createdBy:{id:person.id,name:person.name},history:[{actor:person.name,at:stamp,summary:'Follow-up task created for a deferred Talent review requirement.',note:''}]});
        store.taskNotifications.push({id:crypto.randomUUID(),taskId,recipientUserId:person.id,title,message:'A task needs your attention.',readAt:null,createdAt:stamp});
      }
    }
    a.updated_at=now();store.reviewDeferralRequests[body.requestId]=fingerprint;
    notice('Sample requirement updated. Verification stays pending until actually completed.');return queue();
  }
  const isReviewDeferralTask=task=>Boolean(store.reviewDeferralTaskIds[task.id]);
  const reviewTaskRole=person=>['admin','talent_management'].includes(person.role);
  const taskReadable=task=>(!isReviewDeferralTask(task)||reviewTaskRole(personas[selected]))&&(task.assignees.some(p=>p.id===personas[selected].id)||task.createdBy.id===personas[selected].id);
  function taskAssignees(task){return Object.values(personas).filter(p=>isReviewDeferralTask(task)?reviewTaskRole(p):['admin','sales','talent_management'].includes(p.role)).map(p=>({id:p.id,userId:p.id,name:p.name,role:p.role}));}
  function taskWorkspace(){
    const actor=personas[selected].id,tasks=store.tasks.filter(taskReadable).map(t=>({...t,isNew:!t.viewedBy?.includes(actor)}));
    const visibleIds=new Set(tasks.map(t=>t.id));
    const notifications=store.taskNotifications.filter(n=>n.recipientUserId===actor&&visibleIds.has(n.taskId)).map(({recipientUserId,...notification})=>notification);
    return{tasks,notifications,assignees:Object.values(personas).filter(p=>['admin','sales','talent_management'].includes(p.role)).map(p=>({id:p.id,userId:p.id,name:p.name,role:p.role})),summary:{open:tasks.filter(t=>t.status!=='completed').length,overdue:0,urgentUnread:notifications.filter(n=>!n.readAt).length}};
  }
  function clientTalent(){const a=store.applicants[0];return{talents:[{id:a.id,displayName:a.full_name,location:{country:a.country,timeZone:a.timezone},skills:{verified:a.verified_skills},experience:{years:a.relevant_experience_years,summary:a.relevant_experience_summary,educationAndTraining:a.education_training_summary},screening:{englishResult:a.english_test_result,personalityResult:a.personality_profile_score,computerSpecifications:a.computer_specs,internetSpeed:a.internet_speed},assignments:[{id:id(21),status:'active',startDate:a.created_at.slice(0,10),scheduleSummary:'Monday–Friday · Philippine Time'}]}]};}
  function clientProfile(){const c=store.clients[0];return{profile:{contact:{fullName:c.primaryContact.name,phone:c.primaryContact.phone},company:c.company,signInEmail:'alex@example.test'},permissions:{canEditCompany:true}};}
  function tracker(){return{generatedAt:now(),viewerRole:personas[selected].role,rows:store.clients.flatMap(c=>c.hiringRequests.map(r=>({clientId:c.id,clientName:c.company.name,requestId:r.id,roleTitle:r.roleTitle,ownerId:id(3),ownerName:'Jordan Lee',status:r.status,stage:r.status==='filled'?'active':'matching',candidateCount:0,interviewCount:0,placementCount:r.status==='filled'?1:0,seatCount:1,activePlacementCount:r.status==='filled'?1:0,onboardingCount:0,targetStartDate:day(),lastActivityAt:now(),nextInterviewAt:'',attentionCode:'',nextAction:r.status==='filled'?'view_placement':'find_candidates',responsibleRole:'sales'})))};}
  function checkins(method,body,u){
    if(!['talent','sales'].includes(selected)||u.searchParams.has('applicantId')&&selected==='sales')return null;
    if(method==='GET'&&u.searchParams.get('applicantId')===id(11))return{viewerRole:personas[selected].role,subject:'talent',talentName:store.applicants[1].full_name,today:day(),placements:[],plans:[],notes:[],total:0};
    const actor=personas[selected],side=selected==='sales'?'client':'talent';
    if(method==='GET'&&!(u.searchParams.get('placementId')===id(21)||u.searchParams.get('applicantId')===id(10)))return null;
    store.checkins||={plans:[],notes:[],requests:[]};const state=store.checkins;
    function task(plan){let t=store.tasks.find(t=>t.source?.planId===plan.id&&t.status==='open');if(!plan.enabled){if(t){t.status='completed';t.progress='completed';t.source.state='cancelled';}return;}if(!t){t={id:crypto.randomUUID(),title:'Complete '+(side==='client'?'Client':'Talent')+' check-in',details:'Fictional check-in reminder. Record an outcome in Check-ins.',kind:'staff_task',version:1,progress:'not_started',status:'open',priority:'normal',createdAt:now(),updatedAt:now(),createdBy:{id:actor.id,name:actor.name},relatedLabel:'Jamie Cruz · Sample Company',history:[],source:{kind:'placement_checkin',placementId:id(21),applicantId:id(10),planId:plan.id,side,state:'open'}};store.tasks.push(t);}t.dueDate=plan.nextDue;t.assignees=[{id:actor.id,userId:actor.id,name:actor.name}];t.assignedTo={userId:actor.id,name:actor.name};}
    if(method==='POST'&&!state.requests.includes(body.requestId)){
      if(body.placementId!==id(21)||body.side!==side)return null;
      if(body.action==='schedule'){let p=state.plans.find(p=>p.side===side);if((p?.version||0)!==body.version||body.ownerId!==actor.id)return null;if(!p){p={id:crypto.randomUUID(),placementId:id(21),clientName:store.companyName,side,version:0};state.plans.push(p);}Object.assign(p,{ownerId:actor.id,ownerName:actor.name,cadenceDays:body.cadenceDays,nextDue:body.nextDue,enabled:body.enabled,version:p.version+1});task(p);}
      else if(['record','correct'].includes(body.action)){const old=state.notes.find(n=>n.id===body.noteId),p=state.plans.find(p=>p.id===body.planId);if(body.action==='correct'&&(!old||old.side!==side||old.version!==body.version))return null;if(body.planId&&(!p||!p.enabled||p.version!==body.planVersion))return null;const note={...body,id:old?.id||crypto.randomUUID(),placementId:id(21),clientName:store.companyName,authorName:actor.name,recordedAt:now(),version:(old?.version||0)+1,revisions:old?[{...clone(old),revisions:[]},...old.revisions]:[]};state.notes=state.notes.filter(n=>n.id!==note.id);state.notes.unshift(note);if(p){const t=store.tasks.find(t=>t.source?.planId===p.id&&t.status==='open');if(t){t.status='completed';t.progress='completed';t.source.state='completed';}const d=new Date(day()+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+p.cadenceDays);p.nextDue=d.toISOString().slice(0,10);p.enabled=p.cadenceDays>0;p.version++;task(p);}}
      else return null;state.requests.push(body.requestId);notice('Sample check-in saved. Private notes are visible only to authorized sample staff.');
    }
    const notes=state.notes.filter(n=>(selected==='talent'||n.side==='client')&&(!u.searchParams.get('kind')||n.kind===u.searchParams.get('kind'))&&(!u.searchParams.get('from')||n.observedOn>=u.searchParams.get('from'))&&(!u.searchParams.get('to')||n.observedOn<=u.searchParams.get('to'))),offset=Number(u.searchParams.get('offset')||0);
    return{viewerRole:actor.role,subject:u.searchParams.has('applicantId')?'talent':'placement',talentName:'Jamie Cruz',today:day(),placements:[{id:id(21),clientId:id(50),clientName:store.companyName,canRecord:true,canSchedule:true,sides:[side],owners:[{id:actor.id,name:actor.name,sides:[side]}]}],plans:state.plans.filter(p=>selected==='talent'||p.side==='client').map(p=>({...p,canManage:p.side===side})),notes:notes.slice(offset,offset+30).map(n=>({...n,canCorrect:n.side===side})),total:notes.length};
  }
  function dreamPathway(method,body,u){
    const applicantId=method==='GET'?u.searchParams.get('applicantId'):body.applicantId,a=store.applicants.find(a=>a.id===applicantId);
    if(!a||!['talent','va'].includes(selected)||(selected==='va'&&a.auth_user_id!==personas.va.id))return null;
    store.dreams||={};const d=store.dreams[a.id]||={applicantId:a.id,dream:a.greatest_dream,plan:null,milestones:[],meetings:[],history:[],requests:[]};
    const staff=Object.values(personas).filter(p=>['talent_management','sales'].includes(p.role)).map(p=>({id:p.id,name:p.name,role:p.role,ready:true}));
    function reviewTask(){const p=d.plan;let t=store.tasks.find(t=>t.source?.planId===p.id&&t.source.reviewCycle===p.reviewCycle);if(p.status==='paused'){if(t){t.status='completed';t.progress='completed';}return;}if(!t){t={id:crypto.randomUUID(),title:'Complete Dream Check-In',details:'Open Dream Pathway in Benefits to schedule and record this sample review.',kind:'staff_task',version:1,progress:'not_started',status:'open',priority:'normal',createdAt:now(),updatedAt:now(),relatedLabel:a.full_name,createdBy:{id:id(2),name:personas.talent.name},assignees:[{id:id(2),userId:id(2),name:personas.talent.name}],assignedTo:{userId:id(2),name:personas.talent.name},history:[],source:{kind:'dream_pathway',applicantId:a.id,planId:p.id,reviewCycle:p.reviewCycle,milestoneId:null}};store.tasks.push(t);}t.dueDate=p.nextReviewOn;t.status='open';t.progress='not_started';}
    if(method==='POST'&&!d.requests.includes(body.requestId)){
      if(selected!=='talent'||(d.plan?.version||0)!==body.version)return null;
      if(body.action==='plan'){if(body.ownerId!==id(2))return null;if(d.plan&&d.plan.anchorDate!==body.anchorDate)return null;d.plan={...d.plan,...body,id:d.plan?.id||crypto.randomUUID(),ownerName:personas.talent.name,reviewCycle:d.plan?.reviewCycle||0,nextReviewOn:d.plan?.nextReviewOn||body.anchorDate};reviewTask();}
      else if(!d.plan)return null;
      else if(body.action==='milestone'){const m=d.milestones.find(m=>m.id===body.milestoneId);if(body.milestoneId&&!m)return null;const step={...m,...body,id:m?.id||crypto.randomUUID()},others=d.milestones.filter(x=>x.id!==step.id);others.splice(Math.min(body.position-1,others.length),0,step);d.milestones=others.map((x,i)=>({...x,position:i+1}));}
      else if(body.action==='task'){
        if(!body.assigneeIds?.length||body.assigneeIds.some(x=>x!==id(2)))return null;
        store.tasks.push({id:crypto.randomUUID(),title:body.title,details:body.details,dueDate:body.dueDate,kind:'staff_task',version:1,progress:'not_started',status:'open',priority:'normal',createdAt:now(),updatedAt:now(),relatedLabel:a.full_name,createdBy:{id:id(2),name:personas.talent.name},assignees:[{id:id(2),userId:id(2),name:personas.talent.name}],assignedTo:{userId:id(2),name:personas.talent.name},history:[],source:{kind:'dream_pathway',applicantId:a.id,planId:d.plan.id,milestoneId:body.milestoneId,reviewCycle:null}});
      }else if(body.action==='meeting'){
        if(d.plan.status!=='active'||!body.attendeeIds?.length||body.attendeeIds.some(x=>!staff.some(s=>s.id===x))||Date.parse(body.startsAt)<Date.now())return null;
        if(body.kind==='quarterly'&&d.meetings.some(m=>m.kind==='quarterly'&&m.reviewCycle===d.plan.reviewCycle&&m.status!=='cancelled'))return null;
        d.meetings.unshift({...body,id:crypto.randomUUID(),reviewCycle:body.kind==='quarterly'?d.plan.reviewCycle:null,status:'scheduled',calendarStatus:'synced',attendeeNames:[a.full_name,...staff.filter(s=>body.attendeeIds.includes(s.id)).map(s=>s.name)],summary:''});
      }else if(['complete','cancel'].includes(body.action)){
        const m=d.meetings.find(m=>m.id===body.meetingId);if(!m||m.status!=='scheduled'||body.action==='complete'&&Date.parse(m.startsAt)>Date.now())return null;
        m.status=body.action==='complete'?'completed':'cancelled';m.summary=body.summary||'';
        if(body.action==='complete'&&m.kind==='quarterly'){const t=store.tasks.find(t=>t.source?.planId===d.plan.id&&t.source.reviewCycle===d.plan.reviewCycle);if(t){t.status='completed';t.progress='completed';}d.plan.reviewCycle++;const date=new Date(d.plan.anchorDate+'T12:00:00Z'),originalDay=date.getUTCDate();date.setUTCDate(1);date.setUTCMonth(date.getUTCMonth()+d.plan.reviewCycle*3);const last=new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,0)).getUTCDate();date.setUTCDate(Math.min(originalDay,last));d.plan.nextReviewOn=date.toISOString().slice(0,10);reviewTask();}
      }else return null;
      d.plan.version=(d.plan.version||0)+1;d.requests.push(body.requestId);d.history.unshift({summary:'Sample pathway updated',actorName:personas.talent.name,at:now()});notice('Sample Dream Pathway saved. No real invitations or emails were sent.');
    }
    return{...clone(d),canManage:selected==='talent',staff:selected==='talent'?staff:[],history:selected==='talent'?clone(d.history):[],tasks:selected==='talent'?store.tasks.filter(t=>t.source?.planId===d.plan?.id).map(t=>({id:t.id,title:t.title,status:t.status,dueDate:t.dueDate,canOpen:true,milestoneTitle:d.milestones.find(m=>m.id===t.source.milestoneId)?.title})):[]};
  }
  async function dispatch(url,options={}){
    const u=new URL(typeof url==='string'?url:url.url,'https://test.invalid'),name=u.pathname.split('/').pop();let body={};try{body=JSON.parse(options.body||'{}');}catch{}
    const method=options.method||'GET';let result;
    if(name==='talent-assessment-classification'){
      if(u.origin!=='https://test.invalid'||u.pathname!=='/.netlify/functions/talent-assessment-classification'||u.search)return new Response('{}',{status:403});
      const allowed=['assessment','english_proof','disc_assessment','enneagram_assessment','mbti_assessment'];
      const keys=['requestId','applicantId','documentId','expectedType','expectedUpdatedAt','documentType'];
      if(Object.keys(body).length!==keys.length||keys.some(k=>!Object.hasOwn(body,k))||!/^[-0-9a-f]{36}$/i.test(body.requestId||'')||!allowed.includes(body.expectedType))return new Response('{}',{status:400});
      const d=store.documents.find(d=>d.id===body.documentId&&d.applicant_id===body.applicantId&&d.organization_id===id(90));
      if(selected!=='talent'||method!=='POST'||!d||d.status==='rejected'||!allowed.includes(d.document_type)||!allowed.includes(body.documentType))return new Response(JSON.stringify({message:'This assessment cannot be classified by this sample role.'}),{status:403});
      const fingerprint=JSON.stringify(body),previous=store.classificationRequests[body.requestId];
      if(previous?previous!==fingerprint||d.document_type!==body.documentType:d.document_type!==body.expectedType||d.updated_at!==body.expectedUpdatedAt)return new Response(JSON.stringify({message:'This file changed. Reopen Change Assessment Type.'}),{status:409});
      if(!previous){
        const before=d.document_type;d.document_type=body.documentType;d.updated_at=new Date(Math.max(Date.now(),Date.parse(d.updated_at)+1)).toISOString();
        store.classificationRequests[body.requestId]=fingerprint;store.classificationAudit.push({documentId:d.id,actorId:personas[selected].id,before,after:d.document_type});
        notice('Sample assessment type saved. No live files were changed.');
      }
      return new Response(JSON.stringify({documentId:d.id,applicantId:d.applicant_id,documentType:d.document_type,updatedAt:d.updated_at}),{headers:{'Content-Type':'application/json'}});
    }
    // This fictional upload destination never reaches a network. The live upload
    // component still performs its normal prepare / PUT / complete sequence.
    if(u.origin==='https://test.invalid'&&u.pathname.startsWith('/storage/v1/object/upload/sign/soro-private-documents/')&&method==='PUT'){
      const upload=store.uploads.find(x=>x.url===u.href&&x.userId===personas[selected].id);
      if(selected!=='va'||!upload||options.signal?.aborted||!(options.body instanceof Blob)||options.body.size!==upload.size)return new Response('{}',{status:403});
      if(localFiles.has(upload.path))return new Response('{}',{status:409});
      localFiles.set(upload.path,{blob:options.body,url:URL.createObjectURL(options.body)});return new Response('{}',{status:200});
    }
    // Only listed local API paths are modeled. Even a matching basename on an external URL is rejected.
    if(u.origin!=='https://test.invalid'||!u.pathname.startsWith('/.netlify/functions/'))return new Response(JSON.stringify({message:'External services are disabled in Test Mode.'}),{status:403});
    if(name==='talent-profile-files'&&method==='POST'){
      if(selected!=='va')return new Response('{}',{status:403});
      if(body.action==='prepare'){
        try{w.SoroTalentSelfUploads.fileInfo({name:body.name,size:body.size,type:body.type},body.kind);}catch{return new Response(JSON.stringify({message:'Choose a supported file within the upload limit.'}),{status:400});}
        let upload=store.uploads.find(x=>x.requestId===body.requestId&&x.userId===personas.va.id);
        if(!upload){const fileId=crypto.randomUUID(),path='samples/'+id(10)+'/'+fileId+'/'+encodeURIComponent(body.name);upload={...body,fileId,path,userId:personas.va.id,url:'https://test.invalid/storage/v1/object/upload/sign/soro-private-documents/'+path};store.uploads.push(upload);}
        result={fileId:upload.fileId,url:upload.url,complete:!!upload.complete};
      }else if(body.action==='complete'){
        const upload=store.uploads.find(x=>x.fileId===body.fileId&&x.userId===personas.va.id);
        if(!upload||!localFiles.has(upload.path))return new Response(JSON.stringify({message:'Choose the file again to finish this sample upload.'}),{status:409});
        if(!upload.complete){store.documents.push({id:upload.fileId,applicant_id:id(10),organization_id:id(90),file_name:upload.name,document_type:upload.kind,status:'uploaded',storage_path:upload.path,external_url:null,created_at:new Date(Date.now()+store.documents.length).toISOString()});upload.complete=true;}
        result={documentId:upload.fileId};notice('Sample file saved in this test session only. It was not uploaded to a live account.');
      }else return new Response('{}',{status:400});
    }
    else if(name==='talent-healthcare'&&method==='POST'){
      const a=store.applicants.find(a=>a.id===body.applicantId);if(!canReadFiles(a))return new Response('{}',{status:403});
      store.healthcare||={};const hc=store.healthcare[a.id]||={profile:{version:0,coverageLevel:'not_recorded',plans:['medical','prescription','dental','vision'].map(kind=>({kind,status:'not_recorded'})),dependents:[]},updatedAt:null,actions:[]};
      if(body.action==='save'&&selected==='talent'&&body.expectedVersion===hc.profile.version){hc.profile={...clone(body.profile),version:hc.profile.version+1};hc.updatedAt=now();notice('Sample healthcare details saved for this test session only.');}
      else if(body.action!=='view')return new Response(JSON.stringify({message:'This sample healthcare action is unavailable.'}),{status:409});
      result={...hc,canManage:selected==='talent',placements:a.id===id(10)?[{id:id(21),clientName:store.companyName,status:'active'}]:[]};
    }
    else if(name==='talent-portal-access'&&method==='POST'&&body.action==='status'&&selected==='talent'){
      const a=store.applicants.find(a=>a.id===body.applicantId);if(!a)return new Response('{}',{status:404});
      result={access:{applicantId:a.id,authUserId:a.auth_user_id,state:a.auth_user_id?'active':'not_activated',signInEmail:a.auth_user_id?a.email:'',availableActions:a.auth_user_id?['send_password_reset','change_email','pause_access']:['activate']}};
    }
    else if(name==='internal-talent-profile'&&method==='GET'&&selected==='sales'){
      const a=store.applicants.find(a=>a.id===u.searchParams.get('id'));if(!a)return new Response('{}',{status:404});
      result={talent:Object.fromEntries(['id','full_name','preferred_name','country','timezone','status','work_status','availability_note','application_received_at','expected_hourly_rate_text','verified_skills','self_reported_experience_areas','self_reported_skills','other_experience_specialty','relevant_experience_years','relevant_experience_summary','education_training_summary','english_test_result','personality_profile_score','computer_specs','internet_speed'].map(k=>[k,a[k]??'']))};
    }
    else if(name==='activity-history'&&method==='GET'){
      const kind=u.searchParams.get('kind'),subjectId=u.searchParams.get('id')==='self'?id(50):u.searchParams.get('id');
      if(!((['talent','sales'].includes(selected)&&['talent','client','placement','task','document','support','employee'].includes(kind))||(selected==='va'&&kind==='talent'&&subjectId===id(10))||(selected==='client'&&kind==='client'&&subjectId===id(50))))return new Response('{}',{status:403});
      result={subject:{kind,id:subjectId},role:personas[selected].role,total:0,offset:0,rows:[],options:{actors:[]},generatedAt:now(),asOf:now()};
    }
    else if(name==='talent-time-off'&&method==='GET')result={generatedAt:now(),viewerRole:personas[selected].role,eligibility:selected==='va'?{eligible:true,state:'eligible',placementId:id(21),clientName:store.companyName,workTimezone:'Asia/Manila',minStartDate:day()}:null,requests:[]};
    else if(name==='placement-checkins'){result=checkins(method,body,u);if(!result)return new Response(JSON.stringify({message:'This sample role or record cannot perform this check-in action.'}),{status:403});}
    else if(name==='dream-inspiration'){
      store.inspirations||={};const aid=body.applicantId||u.searchParams.get('applicantId'),a=store.applicants.find(x=>x.id===aid);
      const photoId=u.searchParams.get('photoId');
      if(photoId){const entry=Object.values(store.inspirations).find(x=>x.photoId===photoId),file=localFiles.get('dream/'+photoId);if(!entry||!file||!(selected==='talent'||selected==='va'&&entry.applicantId===id(10)||selected==='client'&&entry.applicantId===id(10)&&entry.sharedPhoto))return new Response('{}',{status:403});result={url:file.url,expiresIn:60};}
      else if(!a||selected==='sales'||selected==='client'&&u.searchParams.get('shared')!=='true'||selected==='va'&&a.auth_user_id!==personas.va.id)return new Response('{}',{status:403});
      else {
        const state=store.inspirations[aid]||={applicantId:aid,photoId:null,caption:'',version:0,sharedStory:'',sharedPhoto:false};
        if(selected==='client'){if(aid!==id(10))return new Response('{}',{status:403});result={shared:!!(state.sharedStory||state.sharedPhoto),story:state.sharedStory,photoId:state.sharedPhoto?state.photoId:null,caption:state.sharedPhoto?state.caption:''};}
        else {
          if(method==='POST'){
            if(body.version!==state.version)return new Response(JSON.stringify({message:'Sharing settings changed. Refresh and try again.'}),{status:409});
            if(['upload','caption','remove'].includes(body.action)&&selected!=='va')return new Response('{}',{status:403});
            if(body.action==='upload'){
              if(!body.image||!['image/jpeg','image/png','image/webp'].includes(body.image.type)||typeof body.image.dataBase64!=='string'||body.image.dataBase64.length>4194304)return new Response('{}',{status:400});
              const bytes=Uint8Array.from(atob(body.image.dataBase64),c=>c.charCodeAt(0)),blob=new Blob([bytes],{type:body.image.type});
              state.photoId=body.requestId;state.caption=body.caption;state.sharedPhoto=false;localFiles.set('dream/'+body.requestId,{blob,url:URL.createObjectURL(blob)});
            }else if(body.action==='remove'){state.photoId=null;state.caption='';state.sharedPhoto=false;}
            else if(body.action==='caption'){state.caption=body.caption;state.sharedPhoto=false;}
            else if(body.action==='share'){if(aid!==id(10)||body.placementId!==id(21)||body.clientId!==id(50)||body.shareDream&&body.approvedStory!==a.greatest_dream||!body.consentNote?.trim()||body.sharePhoto&&!state.photoId)return new Response('{}',{status:400});state.sharedStory=body.shareDream?a.greatest_dream:'';state.sharedPhoto=body.sharePhoto;}
            else return new Response('{}',{status:400});state.version++;notice('Sample Dream inspiration updated. Nothing was uploaded or shared outside Test Mode.');
          }
          result={applicantId:aid,story:a.greatest_dream,photoId:state.photoId,caption:state.caption,version:state.version,canUpload:selected==='va',canShare:true,self:selected==='va',placements:aid===id(10)?[{id:id(21),clientId:id(50),clientName:store.companyName,shareDream:!!state.sharedStory,sharePhoto:state.sharedPhoto,sharedStory:state.sharedStory}]:[]};
        }
      }
    }
    else if(name==='dream-pathway'){result=dreamPathway(method,body,u);if(!result)return new Response(JSON.stringify({message:'This sample role, record, or action is not available. Refresh and check the selections.'}),{status:403});}
    else if(name==='client-dashboard'&&method==='GET')result=dashboard();
    else if(name==='talent-review-queue'&&method==='GET')result=queue();
    else if(name==='talent-review-deferrals'){
      if(selected!=='talent'||(method==='GET'?u.searchParams.get('applicantId'):body.applicantId)!==id(11))return new Response(JSON.stringify({message:'This sample review is unavailable.'}),{status:403});
      result=method==='GET'?reviewRequirements():changeReviewDeferral(body);
      if(!result)return new Response(JSON.stringify({message:'The sample review changed or required information is missing. Refresh and try again.'}),{status:409});
    }
    else if(name==='talent-verification'){
      if(selected!=='talent'||!['admin','talent_management'].includes(personas[selected].role)||(method==='GET'?u.searchParams.get('applicantId'):body.applicantId)!==id(11))return new Response(JSON.stringify({message:'This sample interview is unavailable.'}),{status:403});
      result=method==='GET'?verification():method==='POST'?recordPreviousInterview(body):null;
      if(!result)return new Response(JSON.stringify({message:'This interview changed or required details are missing. Existing scheduled interviews cannot be overwritten. Refresh and check the fields.'}),{status:409});
    }
    else if(name==='talent-review-queue'&&method==='POST'&&body.action==='begin_review'&&selected==='talent'){store.stage='in_review';store.applicants[1].updated_at=now();result=queue();}
    else if(name==='talent-review-queue'&&method==='POST'&&['mark_bench_ready','return_to_review'].includes(body.action)&&selected==='talent'){
      if(body.applicantId!==id(11)||body.expectedUpdatedAt!==store.applicants[1].updated_at||(body.action==='mark_bench_ready'&&(store.stage!=='in_review'||reviewRequirements().items.some(i=>i.status==='pending'))))return new Response(JSON.stringify({message:'Resolve or explicitly defer each remaining requirement before Bench Ready.'}),{status:409});
      store.stage=body.action==='mark_bench_ready'?'bench_ready':'in_review';store.applicants[1].updated_at=now();result=queue();
    }
    else if((name==='tasks'&&method==='GET')||(name==='task-detail'&&body.action==='workspace'))result=taskWorkspace();
    else if(name==='task-detail'&&body.action==='create'&&['talent','sales'].includes(selected)){const p=body.patch||{},task={id:crypto.randomUUID(),kind:'manual',version:1,...p,status:'open',isUnread:true,progress:'not_started',createdAt:now(),updatedAt:now(),createdBy:{id:personas[selected].id,name:personas[selected].name},history:[],assignees:Object.values(personas).filter(x=>(p.assigneeIds||[]).includes(x.id)).map(x=>({id:x.id,userId:x.id,name:x.name}))};store.tasks.push(task);result={task};notice('Sample task created. It exists only in this Test Mode session.');}
    else if(name==='task-detail'&&['get','view','save'].includes(body.action)){
      const task=taskWorkspace().tasks.some(t=>t.id===body.taskId)&&store.tasks.find(t=>t.id===body.taskId);if(!task)return new Response('{}',{status:404});
      if(body.action==='view'){task.isUnread=false;task.viewedBy=[...new Set([...(task.viewedBy||[]),personas[selected].id])];for(const notification of store.taskNotifications)if(notification.taskId===task.id&&notification.recipientUserId===personas[selected].id)notification.readAt=now();}
      if(body.action==='save'){
        if((task.source?.kind==='placement_checkin'||task.source?.kind==='dream_pathway'&&task.source.reviewCycle!==null))return new Response('{}',{status:403});
        const p=body.patch||{};
        if(isReviewDeferralTask(task)&&Object.hasOwn(p,'assigneeIds')){
          if(!Array.isArray(p.assigneeIds)||!p.assigneeIds.length||p.assigneeIds.length>50||new Set(p.assigneeIds).size!==p.assigneeIds.length||p.assigneeIds.some(userId=>!Object.values(personas).some(person=>person.id===userId&&reviewTaskRole(person))))return new Response(JSON.stringify({message:'Deferred review follow-up tasks can be assigned only to Admin or Talent Management accounts.'}),{status:403});
          task.assignees=taskAssignees(task).filter(person=>p.assigneeIds.includes(person.id));task.assignedTo={id:task.assignees[0].id,name:task.assignees[0].name};
        }
        for(const key of (selected==='va'?['progress']:['title','details','relatedLabel','dueDate','priority','progress']))if(Object.hasOwn(p,key))task[key]=p[key];task.status=task.progress==='completed'?'completed':'open';task.version++;task.history.unshift({actor:personas[selected].name,at:now(),summary:'Sample task updated',note:p.note||''});notice('Sample task saved. Switch views to inspect the shared update.');
      }
      result={task:{...task,canUpdateProgress:!(task.source?.kind==='placement_checkin'||task.source?.kind==='dream_pathway'&&task.source.reviewCycle!==null),canEditDetails:selected!=='va'&&!(task.source?.kind==='placement_checkin'||task.source?.kind==='dream_pathway'&&task.source.reviewCycle!==null),canAssign:isReviewDeferralTask(task)&&reviewTaskRole(personas[selected])},history:task.history,assignees:taskAssignees(task)};
    }
    else if(name==='client-profile'&&selected==='client'){if(method==='PATCH'){const c=store.clients[0];Object.assign(c.company,body.company||{});if(body.contact?.fullName)c.primaryContact.name=body.contact.fullName;if(Object.hasOwn(body.contact||{},'phone'))c.primaryContact.phone=body.contact.phone;store.contactName=c.primaryContact.name;store.companyName=c.company.name;notice('Sample account details saved. The Sales view uses this same sample account.');}result=clientProfile();}
    else if(name==='client-talent-profile'&&method==='GET'&&selected==='client')result=clientTalent();
    else if(name==='sales-lifecycle-tracker'&&method==='GET'&&selected==='sales')result=tracker();
    else if(name==='available-talent-bench'&&method==='GET')result={generatedAt:now(),viewerRole:personas[selected].role,items:[],salesOwners:[{id:id(3),name:'Jordan Lee',claimed:0,capacity:10}],caseload:{ownerId:id(3),claimed:0,capacity:10,remaining:10}};
    else if(name==='client-shortlists'&&method==='GET')result={generatedAt:now(),viewerRole:personas[selected].role,hiringRequests:[],candidates:[],notifications:[]};
    else if(name==='document-center'&&method==='GET'){
      const documents=(u.searchParams.get('view')==='mine'&&selected!=='va'?[]:tableRows('documents')).filter(d=>(!u.searchParams.get('subjectId')||d.applicant_id===u.searchParams.get('subjectId'))&&(!u.searchParams.get('q')||d.file_name.toLowerCase().includes(u.searchParams.get('q').toLowerCase())));
      result=u.searchParams.has('notifications')?{count:0}:{internal:['sales','talent'].includes(selected),canManageTemplates:false,requests:[],files:documents.map(d=>({id:d.id,name:d.file_name,category:d.document_type,subjectName:store.applicants.find(a=>a.id===d.applicant_id)?.full_name,createdAt:d.created_at,origin:'legacy',canOpen:true,canClassify:false})),templates:[],packets:[],total:documents.length,hasMore:false};
    }
    else if(name==='portal-feedback'&&method==='GET')result={items:[],canReview:false,hasMore:false};
    else if(name==='placement-ending'&&method==='GET'&&selected==='talent')result={viewerRole:personas[selected].role,total:1,placements:[{id:id(21),applicantId:id(10),talentName:store.applicants[0].full_name,clientName:store.companyName,today:day(),canPlan:true,openSessions:store.workday==='started'?1:0,status:'active',startDate:store.applicants[0].created_at.slice(0,10),endDate:null,schedule:'Monday–Friday · Philippine Time',timezone:'Asia/Manila',hiringRequestId:id(20),ending:null,healthcareReady:false}]};
    else if(name==='support-tickets'&&method==='GET')result=u.searchParams.has('notifications')?{unread:0}:{tickets:[],total:0,hasMore:false,internal:['sales','talent'].includes(selected),isAdmin:false,team:personas[selected].role,summary:{open:0,in_progress:0,waiting_on_client:0,resolved:0},attentionSummary:{total:0}};
    else if(name==='work-log'&&method==='GET')result={generatedAt:now(),viewerRole:personas[selected].role,placements:[{id:id(21),talentName:'Jamie Cruz',clientName:store.companyName,status:'active',canShare:selected==='va',canRequest:selected==='client'}],sessions:store.workday==='not_started'?[]:[{id:id(22),placementId:id(21),workDate:store.workDate,startedAt:store.startedAt,checkedOutAt:store.checkedOutAt||null,timezone:'Asia/Manila'}],requests:[],images:[],total:store.workday==='not_started'?0:1,offset:0};
    else if(name==='active-talent-today'&&method==='GET')result={generatedAt:now(),summary:{activeTalent:1,checkedInToday:store.workday==='not_started'?0:1,workingNow:store.workday==='started'?1:0,completedToday:store.workday==='completed'?1:0,notStarted:store.workday==='not_started'?1:0,needsReview:0},rows:[{applicantId:id(10),fullName:store.applicants[0].full_name,preferredName:'Jamie',placementId:id(21),clientId:id(50),clientName:store.companyName,ownerName:personas.talent.name,placementStatus:'active',placementStartDate:store.applicants[0].created_at.slice(0,10),scheduleSummary:'Monday–Friday · Philippine Time',workDate:store.workDate||day(),workTimezone:'Asia/Manila',attendanceState:store.workday,accessState:'ready',startedAt:store.startedAt||'',checkedOutAt:store.checkedOutAt||'',needsAttention:false}]};
    else if(name==='operations-reports'&&method==='GET')result={generatedAt:now(),role:personas[selected].role,report:u.searchParams.get('report'),rows:[],total:0,offset:0,summary:{total:0,statuses:{},flags:{}},options:{owners:[],statuses:[],teams:[],areas:[]}};
    else if(name==='talent-attendance'&&selected==='va'){
      if(method==='POST'&&body.action==='start_day'&&store.workday==='not_started'){store.workday='started';store.startedAt=now();store.workDate=day();notice('Sample workday started. No live attendance was recorded.');}
      if(method==='POST'&&body.action==='check_out'&&store.workday==='started'){store.workday='completed';store.checkedOutAt=now();notice('Sample workday completed. No live attendance was recorded.');}
      result={state:store.workday,eligible:true,applicantId:id(10),placementId:id(21),sessionId:id(22),clientName:store.companyName,scheduleSummary:'Monday–Friday · 9 AM–5 PM Philippine Time',workDate:store.workDate||day(),workTimezone:'Asia/Manila',startedAt:store.startedAt||'',checkedOutAt:store.checkedOutAt||''};
    }
    else if(name==='global-search'&&method==='GET'){
      const q=(u.searchParams.get('q')||'').trim().toLowerCase(),staff=['sales','talent'].includes(selected),matches=v=>q.length>=2&&String(v).toLowerCase().includes(q);
      result={results:staff?[...store.applicants.filter(a=>matches(a.full_name+' '+a.email)).map(a=>({entityType:'talent',recordId:a.id,primaryLabel:a.full_name,secondaryLabel:'Goes by '+a.preferred_name,statusLabel:a.status})),...store.clients.filter(c=>matches(c.company.name+' '+c.primaryContact.name+' '+c.primaryContact.email)).map(c=>({entityType:'client',recordId:c.id,primaryLabel:c.company.name,secondaryLabel:c.primaryContact.name,statusLabel:c.lifecycleStage}))]:[]};
      result={query:q,clients:result.results.filter(r=>r.entityType==='client'),talent:result.results.filter(r=>r.entityType==='talent')};
    }
    else {if(method!=='GET')unavailable();return new Response(JSON.stringify({message:'Not available in Test Mode. No live request was sent.'}),{status:409,headers:{'Content-Type':'application/json'}});}
    return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json'}});
  }
  // There is deliberately no reference to native fetch and no network fallback.
  w.fetch=dispatch;
  w.XMLHttpRequest=function(){throw new Error('Network is disabled in Test Mode.');};
  w.WebSocket=w.EventSource=w.Worker=function(){throw new Error('External services are disabled in Test Mode.');};
  w.open=()=>{notice('External links and file downloads are disabled in Test Mode.');return null;};
  w.addEventListener?.('pagehide',()=>{for(const file of localFiles.values())URL.revokeObjectURL(file.url);localFiles.clear();});
  document.addEventListener('click',event=>{const a=event.target.closest('a');if(a&&a.getAttribute('href')&&!a.getAttribute('href').startsWith('#')){event.preventDefault();event.stopImmediatePropagation();notice('External links are disabled in Test Mode.');}},true);
  // Opaque sandbox origins intentionally cannot use browser storage. Supply only disposable preferences.
  for(const key of ['localStorage','sessionStorage']){const memory=new Map();try{Object.defineProperty(w,key,{value:{getItem:k=>memory.get(k)||null,setItem:(k,v)=>memory.set(k,String(v)),removeItem:k=>memory.delete(k),clear:()=>memory.clear()}});}catch{}}
  w.SoroTestSession={id,personas,access,queue,dashboard,get store(){return store;},get selected(){return selected;},select(value){if(personas[value])selected=value;},reset,notice};
}(window));
