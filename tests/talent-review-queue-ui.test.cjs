const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const modulePath = path.join(root, 'operations', 'talent-review-queue.js');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const applicantId = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const updatedAt = '2026-08-30T23:00:00.000Z';

test('review action row shares a flexible height without changing dropdown actions', () => {
  const css=read('operations/talent-review-queue.css');
  assert.match(css,/--review-action-height: 3rem/);
  assert.match(css,/\.talent-review-card-main-actions \{ align-items: stretch/);
  assert.match(css,/\.talent-review-card-main-actions > \.button,\s*\.talent-review-secondary > summary \{[\s\S]*?min-height: var\(--review-action-height\);[\s\S]*?height: auto;/);
  assert.match(css,/\.talent-review-action-divider \{ align-self: center/);
  assert.match(css,/\.talent-review-secondary\[open\] > summary::after/);
  assert.match(css,/@media \(max-width: 430px\)[\s\S]*\.talent-review-verification \{ flex: 1 1 100%; \}/);
  assert.match(read('operations/index.html'),/talent-review-queue.css\?v=20260914-references/);
});

const APPLICANT_KEYS = Object.freeze([
  'hasNativeSubmission',
  'applicantId', 'fullName', 'preferredName', 'email', 'applicationReceivedAt',
  'updatedAt', 'stage', 'archived', 'owner', 'resume', 'checklist', 'allowedActions'
]);

function applicant(overrides = {}) {
  return {
    applicantId,
    fullName: 'Santos, Mariel Anne',
    preferredName: 'Mariel',
    email: 'mariel@example.com',
    applicationReceivedAt: '2026-08-30T20:00:00.000Z',
    updatedAt,
    stage: 'submitted',
    archived: false,
    owner: { id: ownerId, name: 'Jordan Reed' },
    resume: { available: true, label: 'Résumé available' },
    checklist: [
      { key: 'core_profile', label: 'Core profile', state: 'complete' },
      { key: 'resume', label: 'Resume', state: 'missing' }
    ],
    allowedActions: ['begin_review', 'request_more_info', 'decline', 'archive'],
    ...overrides
  };
}

function queuePayload(role = 'admin', rows = [applicant()], overrides = {}) {
  return {
    generatedAt: '2026-08-30T23:05:00.000Z',
    viewerRole: role,
    summary: {
      all: rows.length,
      submitted: rows.filter(row => !row.archived && row.stage === 'submitted').length,
      in_review: rows.filter(row => !row.archived && row.stage === 'in_review').length,
      needs_more_info: rows.filter(row => !row.archived && row.stage === 'needs_more_info').length,
      bench_ready: rows.filter(row => !row.archived && row.stage === 'bench_ready').length,
      closed: rows.filter(row => row.archived || row.stage === 'declined').length
    },
    applicants: rows,
    ...overrides
  };
}

test('recorded results display separately from source completion and refresh after profile saves', async t => {
  let recorded = false;
  const list = () => [
    {key:'english',label:'English assessment',state:'complete',resultRecorded:true,evidenceState:'available'},
    {key:'disc',label:'DISC assessment',state:recorded?'needs_review':'missing',resultRecorded:recorded,evidenceState:'unclassified_available'},
    {key:'equipment',label:'Computer specifications',state:'complete',resultRecorded:false,evidenceState:'available'}
  ];
  const {ui,listeners,calls} = installUi(t,{responsePayload:()=>queuePayload('admin',[applicant({stage:'in_review',checklist:list(),allowedActions:['mark_bench_ready']})])});
  const target = {innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target); await new Promise(resolve=>setImmediate(resolve));
  ui.setSearch('Mariel'); ui.setSort('oldest');
  assert.match(target.innerHTML,/File on Record/);
  assert.match(target.innerHTML,/Result Not Recorded/);
  recorded = true;
  listeners.get('soro:talent-screening-updated')();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,2);
  assert.match(target.innerHTML,/Check File Category/);
  assert.match(target.innerHTML,/talent-review-recorded-detail[^>]*>Result Recorded/);
  assert.equal((target.innerHTML.match(/talent-review-progress-item is-recorded/g)||[]).length,1);
  assert.match(target.innerHTML,/data-review-action="mark_bench_ready" disabled/);
  assert.match(target.innerHTML,/value="Mariel"/);
  assert.match(target.innerHTML,/<option value="oldest" selected>/);
  assert.doesNotMatch(target.innerHTML,/Loading applications/);
  globalThis.soroCurrentAccess={role:'sales'};
  listeners.get('soro:talent-screening-updated')();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls.length,2,'unauthorized roles do not request the queue');
  const enhancement=read('operations/operations-enhancements.js');
  const save=enhancement.slice(enhancement.indexOf('Object.assign(applicant, updates)'));
  assert.match(save,/\.close\(\);\s*window.dispatchEvent\(new CustomEvent\('soro:talent-screening-updated'/);
});

test('recording metadata is validated and private data is dropped in the browser', t => {
  const {ui} = installUi(t);
  const item={key:'disc',label:'DISC',state:'needs_review',resultRecorded:true,evidenceState:'missing',rawScore:'PRIVATE'};
  const payload=queuePayload('admin',[applicant({checklist:[item]})]);
  assert.doesNotMatch(JSON.stringify(ui.normalizePayload(payload,'admin')),/PRIVATE/);
  for(const change of [{resultRecorded:1},{evidenceState:'guessed'},{state:'complete'}]) {
    const bad=queuePayload('admin',[applicant({checklist:[{...item,...change}]})]);
    assert.throws(()=>ui.normalizePayload(bad,'admin'),/invalid applicant/);
  }
});

test('received submissions never turn staff review green; recorded results and verified counts do', async t => {
  let saved = false;
  let submissionOpen = false;
  const checklist = () => [
    {key:'core_profile',label:'Core profile',state:'complete'},
    {key:'resume',label:'Resume',state:'complete'},
    ...['english','disc','enneagram','mbti','internet','equipment'].map((key,index) => ({key,label:key,state:'complete',resultRecorded:saved && index < 2,evidenceState:'available'})),
    {key:'skills',label:'Applicant-reported skills',state:'complete',verifiedSkillsCount:saved ? 3 : 0}
  ];
  const {ui,listeners} = installUi(t,{responsePayload:()=>queuePayload('admin',[applicant({checklist:checklist()})])});
  const target = {innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(selector){return selector.startsWith('[data-review-submission=') ? {open:submissionOpen} : null;}};
  ui.mount(target); await new Promise(resolve=>setImmediate(resolve));
  assert.equal((target.innerHTML.match(/Result Not Recorded/g)||[]).length,6);
  assert.equal((target.innerHTML.match(/talent-review-progress-item is-received/g)||[]).length,7);
  assert.equal((target.innerHTML.match(/talent-review-progress-item is-recorded/g)||[]).length,2,'only Core Profile and Resume are complete');
  saved = true;
  submissionOpen = true;
  ui.setSearch('Mariel'); ui.setSort('oldest');
  listeners.get('soro:talent-skills-updated')();
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(target.innerHTML,/3 Skills Verified/);
  assert.equal((target.innerHTML.match(/talent-review-progress-item is-recorded/g)||[]).length,5);
  assert.match(target.innerHTML,/value="Mariel"/);
  assert.match(target.innerHTML,/<option value="oldest" selected>/);
  assert.doesNotMatch(target.innerHTML,/data-review-submission=/,'no duplicate submission section');
});

test('receipt detail is compact for required native uploads and explicit for legacy or missing files', async t => {
  let native = true, missing = false;
  const {ui} = installUi(t,{responsePayload:()=>queuePayload('admin',[applicant({stage:'in_review',hasNativeSubmission:native,checklist:[
    {key:'english',label:'English',state:missing?'missing':'complete',resultRecorded:false,evidenceState:missing?'missing':'available'}
  ]})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(resolve=>setImmediate(resolve));
  assert.match(target.innerHTML,/Result Not Recorded/);
  assert.doesNotMatch(target.innerHTML,/File on Record/,'do not repeat normal mandatory receipt detail');
  assert.match(target.innerHTML,/Schedule \/ Record Interview/);
  native=false;await ui.refresh();
  assert.match(target.innerHTML,/File on Record/);
  native=true;missing=true;await ui.refresh();
  assert.match(target.innerHTML,/No File on Record/,'source exceptions remain visible even for native submissions');
  assert.throws(()=>ui.normalizePayload(queuePayload('admin',[applicant({hasNativeSubmission:'true'})]),'admin'),/invalid applicant/);
});

test('older payloads display unknown review state rather than inferring completion from uploads', async t => {
  const {ui} = installUi(t,{responsePayload:queuePayload('admin',[applicant({checklist:[
    {key:'disc',label:'DISC',state:'complete'},
    {key:'skills',label:'Skills',state:'complete'}
  ]})])});
  const target = {innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target); await new Promise(resolve=>setImmediate(resolve));
  assert.match(target.innerHTML,/Recording Status Not Loaded/);
  assert.match(target.innerHTML,/Skill Verification Not Loaded/);
  assert.doesNotMatch(target.innerHTML,/talent-review-progress-item is-recorded|0 Skills Verified/);
});

test('verified skill count validation is strict and drops private skill details', t => {
  const {ui} = installUi(t);
  const item = {key:'skills',label:'Skills',state:'complete',verifiedSkillsCount:2,verified_skills:['PRIVATE']};
  const result = ui.normalizePayload(queuePayload('admin',[applicant({checklist:[item]})]),'admin');
  assert.equal(result.applicants[0].checklist[0].verifiedSkillsCount,2);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
  for(const value of [-1,1.5,'2',null,Number.MAX_SAFE_INTEGER+1]) {
    assert.throws(()=>ui.normalizePayload(queuePayload('admin',[applicant({checklist:[{...item,verifiedSkillsCount:value}]})]),'admin'),/invalid applicant/);
  }
});

test('newest applications sort first across stages, with user-controlled alternatives', async t => {
  const older = applicant({applicantId:requestId, fullName:'Z Older',stage:'needs_more_info',applicationReceivedAt:'2026-08-01T10:00:00Z'});
  const latest = applicant({fullName:'A Newer'});
  const {ui} = installUi(t,{responsePayload:queuePayload('admin',[older,latest])});
  await ui.refresh();
  assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[applicantId,requestId]);
  ui.setSort('oldest'); assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[requestId,applicantId]);
  ui.setSort('name'); assert.equal(ui.visibleApplicants()[0].fullName,'A Newer');
});

test('review keeps multiple worked cards in place until an explicit filter or refresh', async t => {
  let rows=[applicant(),applicant({applicantId:requestId,fullName:'Older',applicationReceivedAt:'2026-08-01T10:00:00Z'})];
  const {ui} = installUi(t,{responsePayload:call=>{
    if(call.options.method==='POST') rows=rows.map(x=>x.applicantId===JSON.parse(call.options.body).applicantId?{...x,stage:'in_review',allowedActions:['request_more_info','mark_bench_ready']}:x).reverse();
    return queuePayload('admin',rows);
  }});
  await ui.refresh(); ui.setStageFilter('submitted');
  await ui.changeApplicant({applicantId,expectedUpdatedAt:updatedAt,action:'begin_review'});
  assert.equal(ui.visibleApplicants()[0].applicantId,applicantId);
  assert.equal(ui.visibleApplicants()[0].stage,'in_review');
  await ui.changeApplicant({applicantId:requestId,expectedUpdatedAt:updatedAt,action:'begin_review'});
  assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[applicantId,requestId]);
  const newest=applicant({applicantId:ownerId,fullName:'Newest arrival',applicationReceivedAt:'2026-09-09T10:00:00Z'});
  rows.unshift(newest);
  await ui.refresh({silent:true});
  assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[applicantId,requestId,ownerId]);
  assert.equal(ui.visibleApplicants()[1].stage,'in_review');
  ui.setStageFilter('submitted');
  assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[ownerId]);
  ui.setStageFilter('all');
  assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[ownerId,applicantId,requestId]);
  ui.setSort('oldest'); assert.equal(ui.visibleApplicants()[0].applicantId,requestId);
  ui.setSearch('no matching name'); assert.equal(ui.visibleApplicants().length,0);
});

test('explicit refresh releases quiet ordering; a removed record is never restored', async t => {
  let rows=[applicant(),applicant({applicantId:requestId,applicationReceivedAt:'2026-08-01T10:00:00Z'})];
  const {ui}=installUi(t,{responsePayload:call=>{
    if(call.options.method==='POST')rows=rows.map(x=>x.applicantId===applicantId?{...x,stage:'in_review'}:x);
    return queuePayload('admin',rows);
  }});
  await ui.refresh();ui.setStageFilter('submitted');
  await ui.changeApplicant({applicantId,expectedUpdatedAt:updatedAt,action:'begin_review'});
  await ui.refresh({silent:true}); assert.equal(ui.visibleApplicants()[0].applicantId,applicantId);
  await ui.refresh();assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[requestId]);
  ui.setStageFilter('all');ui.openResume(applicantId);
  rows=rows.filter(x=>x.applicantId!==applicantId);
  await ui.refresh({silent:true});assert.deepEqual(ui.visibleApplicants().map(x=>x.applicantId),[requestId]);
});

for(const control of ['stage','search','sort'])test(`${control} deliberately clears quiet review state`,async t=>{
  let row=applicant();
  const {ui}=installUi(t,{responsePayload:call=>{
    if(call.options.method==='POST')row={...row,stage:'in_review'};
    return queuePayload('admin',[row]);
  }});
  await ui.refresh();ui.setStageFilter('submitted');
  await ui.changeApplicant({applicantId,expectedUpdatedAt:updatedAt,action:'begin_review'});
  assert.equal(ui.visibleApplicants().length,1);
  if(control==='stage')ui.setStageFilter('submitted');
  if(control==='search')ui.setSearch('no match');
  if(control==='sort')ui.setSort('oldest');
  await ui.refresh({silent:true});assert.equal(ui.visibleApplicants().length,0);
});

test('a pending review response cannot reinstate a hold cleared by the search control',async t=>{
  let resolveSave;
  const {ui}=installUi(t,{responsePayload:call=>call.options.method==='POST'?new Promise(resolve=>{resolveSave=resolve;}):queuePayload()});
  await ui.refresh();
  const saving=ui.changeApplicant({applicantId,expectedUpdatedAt:updatedAt,action:'begin_review'});
  await new Promise(resolve=>setImmediate(resolve));
  ui.setSearch('no matching name');
  resolveSave(queuePayload('admin',[applicant({stage:'in_review'})]));
  await saving;assert.equal(ui.visibleApplicants().length,0);
});

test('silent updates preserve the first visible card rather than an offscreen last-worked card',async t=>{
  const rows=[applicant({stage:'in_review'}),applicant({applicantId:requestId,applicationReceivedAt:'2026-08-01T10:00:00Z'})];
  const {ui}=installUi(t,{responsePayload:queuePayload('admin',rows)});
  let after=false,markup='',moves=[];
  const offscreen={dataset:{reviewApplicant:applicantId},getBoundingClientRect:()=>({top:after?-800:-1000,bottom:-500})};
  const visible={dataset:{reviewApplicant:requestId},getBoundingClientRect:()=>({top:after?20:-30,bottom:500})};
  const target={get innerHTML(){return markup;},set innerHTML(value){markup=value;after=true;},addEventListener(){},removeEventListener(){},querySelectorAll:()=>[offscreen,visible],querySelector:selector=>selector===`[data-review-applicant="${applicantId}"]`?offscreen:selector===`[data-review-applicant="${requestId}"]`?visible:null};
  globalThis.innerHeight=800;globalThis.scrollY=1000;globalThis.scrollBy=options=>moves.push(options.top);
  ui.mount(target);await new Promise(resolve=>setImmediate(resolve));
  ui.openResume(applicantId);after=false;moves=[];
  await ui.refresh({silent:true});assert.deepEqual(moves,[50]);
});

test('submitted action row contains only Start review and expands only after the saved transition', async t => {
  let row=applicant();
  const {ui}=installUi(t,{responsePayload:call=>{
    if(call.options.method==='POST') row={...row,stage:'in_review',allowedActions:['request_more_info','mark_bench_ready','decline']};
    return queuePayload('admin',[row]);
  }});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target); await new Promise(resolve=>setImmediate(resolve));
  const actions=()=>target.innerHTML.match(/<footer class="talent-review-card-actions">([\s\S]*?)<\/footer>/)[1];
  assert.match(actions(),/data-review-action="begin_review"/);
  assert.doesNotMatch(actions(),/data-review-resume|data-review-verification|data-review-interview|More actions/);
  await ui.changeApplicant({applicantId,expectedUpdatedAt:updatedAt,action:'begin_review'});
  assert.match(actions(),/data-review-verification/); assert.match(actions(),/data-review-interview/); assert.match(actions(),/Open résumé/);
  assert.doesNotMatch(target.innerHTML,/Done for now|position held|is-current-review|talent-review-active-note|talent-review-filter-exception|data-review-release/);
  assert.match(target.innerHTML,/<label class="talent-review-sort"><span>Sort by<\/span><select data-review-sort>/);
  const css=read('operations/talent-review-queue.css');
  assert.doesNotMatch(css,/\.talent-review-toolbar label\s*\{|talent-review-active-note|is-current-review|talent-review-filter-exception/);
  assert.match(css,/\.talent-review-search \{[\s\S]*?border: 1px solid/);
});

for (const [role,stage,expected] of [['admin','in_review',true],['admin','submitted',false],['talent_management','in_review',false]]) {
  test(`Review owner Edit button preserves access for ${role} / ${stage}`, async t => {
    const row=applicant({stage,owner:{id:ownerId,name:'A very long Founder name & team <label>'}});
    const {ui}=installUi(t,{role,responsePayload:queuePayload(role,[row])});
    const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
    ui.mount(target); await new Promise(resolve=>setImmediate(resolve));
    assert.match(target.innerHTML,/class="talent-review-owner-copy"/);
    assert.match(target.innerHTML,/A very long Founder name &amp; team &lt;label&gt;/);
    assert.equal(target.innerHTML.includes('data-review-reassign='),expected);
    if(expected) {
      assert.match(target.innerHTML,/class="button talent-review-owner-edit"[^>]+aria-label="Edit review owner for Santos, Mariel Anne">Edit<\/button>/);
      assert.doesNotMatch(target.innerHTML,/>Reassign<\/button>/);
    }
  });
}

test('verification and interview drawers contain independent controls', async t => {
  const row=applicant({stage:'in_review'});
  const {ui}=installUi(t,{responsePayload:call=>call.url.includes('talent-verification') ? {
    generatedAt:updatedAt,viewerRole:'admin',applicant:{applicantId,fullName:row.fullName,email:row.email,stage:'in_review',updatedAt},
    gate:{interviewAddressed:false,referencesAddressed:false,benchReadyEligible:false,blockers:['Interview pending','References pending']},
    interview:null,references:[],interviewers:[{id:ownerId,name:'Interviewer'}],calendarIntegration:{configured:false,organizerLabel:'Soro'}
  } : queuePayload('admin',[row])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(r=>setImmediate(r));
  ui.openVerification(applicantId);await new Promise(r=>setImmediate(r));
  const dialog=()=>target.innerHTML.slice(target.innerHTML.indexOf('<dialog'));
  assert.match(dialog(),/data-review-resume-panel/);assert.match(dialog(),/Add, edit &amp; verify skills/);assert.match(dialog(),/Employment references/);
  assert.doesNotMatch(dialog(),/data-verification-form="schedule_interview"|Internal interview/);
  ui.openVerification(applicantId,'interview');await new Promise(r=>setImmediate(r));
  assert.match(dialog(),/data-verification-form="schedule_interview"/);
  assert.doesNotMatch(dialog(),/data-review-resume-panel|Employment references|Add, edit &amp; verify skills/);
});

function installUi(t, options = {}) {
  const role = options.role || 'admin';
  const responsePayload = options.responsePayload || queuePayload(role);
  const responseStatus = options.responseStatus || 200;
  const keys = [
    'soroCurrentAccess', 'soroSupabase', 'fetch', 'crypto', 'CustomEvent',
    'dispatchEvent', 'addEventListener', 'soroTalentReviewQueue', 'document', 'setInterval',
    'scrollBy', 'scrollTo', 'scrollY', 'innerHeight'
  ];
  const previous = new Map(keys.map(key => [key, Object.prototype.hasOwnProperty.call(globalThis, key)
    ? { exists: true, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) }
    : { exists: false }]));
  const calls = [];
  const events = [];
  globalThis.soroCurrentAccess = { role };
  globalThis.soroSupabase = {
    auth: { getSession: async () => ({ data: { session: { access_token: 'signed-in-review-token' } }, error: null }) }
  };
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    writable: true,
    value: { randomUUID: () => requestId }
  });
  globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  };
  globalThis.dispatchEvent = event => { events.push(event); return true; };
  const listeners = new Map();
  globalThis.addEventListener = (name, handler) => { listeners.set(name, handler); };
  if (options.document) {
    globalThis.document = options.document;
    globalThis.setInterval = () => 0;
  }
  globalThis.fetch = async (url, requestOptions = {}) => {
    const call = { url: String(url), options: requestOptions };
    calls.push(call);
    const payload = await (typeof responsePayload === 'function' ? responsePayload(call, calls.length) : responsePayload);
    return {
      ok: responseStatus >= 200 && responseStatus < 300,
      status: responseStatus,
      text: async () => JSON.stringify(payload)
    };
  };
  delete require.cache[require.resolve(modulePath)];
  const ui = require(modulePath);
  t.after(() => {
    ui.unmount({ clear: false, reset: true });
    delete require.cache[require.resolve(modulePath)];
    for (const [key, state] of previous) {
      if (state.exists) Object.defineProperty(globalThis, key, state.descriptor);
      else delete globalThis[key];
    }
  });
  return { ui, calls, events, listeners };
}

function interviewPayload(interview = null, overrides = {}) {
  return {
    generatedAt: updatedAt, viewerRole: 'admin',
    applicant: {applicantId, fullName:'Legacy Applicant', stage:'in_review', updatedAt},
    gate: {interviewAddressed: interview?.status === 'completed' && ['recommended','follow_up','not_recommended'].includes(interview?.outcome), referencesAddressed:false, benchReadyEligible:false, blockers:['References pending']},
    interview, interviewHistory:[], references:[], interviewers:[], availableAttendees:[],
    calendarIntegration:{configured:false, organizerLabel:''}, ...overrides
  };
}

function historicalInterview(overrides = {}) {
  return {
    interviewId:requestId, status:'completed', recordSource:'historical', occurredOn:'2026-08-15',
    startsAt:null, endsAt:null, timezone:null, updatedAt, roundNumber:1,
    interviewer:{id:null, name:'Jordan Reed'}, additionalAttendees:[],
    outcome:'recommended', scorecard:{communication:4,preparedness:null,roleFit:3,overall:4},
    notes:'Prior interview notes', calendar:{status:'not_applicable',joinUrl:null}, ...overrides
  };
}

test('previous interview action is explicit, validates dates and keeps unknown scores empty', t => {
  const {ui} = installUi(t);
  const input={applicantId,interviewId:null,expectedUpdatedAt:null,occurredOn:'2026-08-15',interviewerName:' Jordan Reed ',outcome:'recommended',communicationScore:'4',preparednessScore:'',roleFitScore:null,overallScore:'5',note:' Completed before the portal. '};
  const body=ui.buildVerificationAction('record_previous_interview',input);
  assert.deepEqual(body,{action:'record_previous_interview',requestId,applicantId,interviewId:null,expectedUpdatedAt:null,occurredOn:'2026-08-15',interviewerName:'Jordan Reed',outcome:'recommended',communicationScore:4,preparednessScore:null,roleFitScore:null,overallScore:5,note:'Completed before the portal.'});
  assert.equal(ui.buildVerificationAction('record_previous_interview',{...input,occurredOn:''}).occurredOn,null);
  assert.equal(ui.buildVerificationAction('record_previous_interview',{...input,interviewId:requestId,expectedUpdatedAt:updatedAt}).interviewId,requestId);
  for(const change of [{occurredOn:'2026-02-30'},{occurredOn:'2999-01-01'},{outcome:''},{outcome:'passed'},{interviewerName:''},{interviewerName:'x'.repeat(181)},{note:''},{note:'x'.repeat(4001)},{communicationScore:0},{communicationScore:6},{interviewId:'bad'},{interviewId:requestId},{expectedUpdatedAt:updatedAt}]) {
    assert.throws(()=>ui.buildVerificationAction('record_previous_interview',{...input,...change}),JSON.stringify(change));
  }
  assert.doesNotMatch(JSON.stringify(body),/startsAt|endsAt|status|additionalAttendee|interviewerUserId|sendEmail/);
});

test('historical interview metadata is validated without turning it into a calendar appointment', t => {
  const {ui}=installUi(t);
  const entry=historicalInterview({occurredOn:null,privateMeetingUrl:'SECRET'});
  const saved=ui.normalizeVerificationPayload(interviewPayload(entry),applicantId,'admin').interview;
  assert.equal(saved.recordSource,'historical');assert.equal(saved.occurredOn,null);
  assert.equal(saved.interviewer.id,null);assert.equal(saved.startsAt,null);
  assert.doesNotMatch(JSON.stringify(saved),/SECRET|privateMeetingUrl/);
  for(const change of [{recordSource:'unknown'},{occurredOn:'not-a-date'},{status:'scheduled'},{timezone:'Asia/Manila'},{startsAt:updatedAt},{endsAt:updatedAt},{interviewer:{id:ownerId,name:'Jordan'}},{calendar:{status:'synced',joinUrl:null}},{outcome:null},{additionalAttendees:[{id:ownerId,name:'Guest'}]}]) {
    assert.throws(()=>ui.normalizeVerificationPayload(interviewPayload({...entry,...change}),applicantId,'admin'),JSON.stringify(change));
  }
  const normal=historicalInterview({recordSource:undefined,occurredOn:undefined,status:'scheduled',outcome:'',startsAt:updatedAt,endsAt:'2026-08-30T23:30:00Z',timezone:'Asia/Manila',interviewer:{id:ownerId,name:'Jordan'},calendar:{status:'synced',joinUrl:null}});
  assert.equal(ui.normalizeVerificationPayload(interviewPayload(normal),applicantId,'admin').interview.recordSource,'scheduled');
});

test('interview drawer offers both paths without requiring a staff account for historical recording', async t => {
  let interview=null;
  const {ui}=installUi(t,{responsePayload:call=>call.url.includes('talent-verification')?interviewPayload(interview):queuePayload('admin',[applicant({stage:'in_review'})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(resolve=>setImmediate(resolve));
  ui.openVerification(applicantId,'interview');await new Promise(resolve=>setImmediate(resolve));
  const markup=target.innerHTML.slice(target.innerHTML.indexOf('<dialog'));
  assert.match(markup,/Schedule New Interview/);assert.match(markup,/Record Previous Interview/);
  assert.match(markup,/data-verification-form="record_previous_interview"/);
  assert.match(markup,/Communication \/ English comprehension score/);
  assert.match(markup,/Leave blank if the original date is unknown/);
  assert.match(markup,/without creating a calendar invitation, email, or follow-up task/);
  assert.match(markup,/Saving satisfies the interview requirement\. Other review requirements still apply before Bench Ready/);
  assert.doesNotMatch(markup,/follow-up recommendation still needs attention before Bench Ready/);
  assert.match(markup,/<option value="" selected disabled>Select the interview recommendation/);
  assert.doesNotMatch(markup,/<details data-interview-choice="[^"]+" open/);
  assert.match(markup,/No eligible interviewer is available/,'scheduling remains independently guarded');
  assert.match(markup,/>Save Previous Interview<\/button>/,'manual recording is available with a typed interviewer');
});

test('manually recorded interview displays honest date, editable scores and completion without auto Bench Ready', async t => {
  let interview=historicalInterview({occurredOn:null});
  const {ui}=installUi(t,{responsePayload:call=>call.url.includes('talent-verification')?interviewPayload(interview):queuePayload('admin',[applicant({stage:'in_review',allowedActions:['mark_bench_ready']})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(resolve=>setImmediate(resolve));
  ui.openVerification(applicantId,'interview');await new Promise(resolve=>setImmediate(resolve));
  const markup=target.innerHTML.slice(target.innerHTML.indexOf('<dialog'));
  assert.match(markup,/Previous Interview Completed/);assert.match(markup,/Recorded manually/);
  assert.match(markup,/Original date unknown/);assert.match(markup,/Edit Previous Interview/);
  assert.match(markup,/name="interviewerName" maxlength="180" value="Jordan Reed"/);
  assert.match(markup,/name="communicationScore"[^>]*value="4"/);
  assert.match(markup,/name="preparednessScore"[^>]*value=""/);
  assert.match(markup,/<option value="recommended" selected>/);
  assert.match(target.innerHTML,/✓ Interview Complete/);
  assert.match(target.innerHTML,/data-review-action="mark_bench_ready" disabled/);
  assert.doesNotMatch(markup,/Join Teams|Retry sync|Check sync|data-verification-form="record_interview_outcome"/);
});

test('active scheduled interviews cannot be replaced by the previous-interview form', async t => {
  const interview=historicalInterview({recordSource:'scheduled',occurredOn:null,status:'scheduled',outcome:'',startsAt:updatedAt,endsAt:'2026-08-30T23:30:00Z',timezone:'Asia/Manila',interviewer:{id:ownerId,name:'Jordan'},calendar:{status:'synced',joinUrl:null}});
  const {ui}=installUi(t,{responsePayload:call=>call.url.includes('talent-verification')?interviewPayload(interview):queuePayload('admin',[applicant({stage:'in_review'})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(resolve=>setImmediate(resolve));
  ui.openVerification(applicantId,'interview');await new Promise(resolve=>setImmediate(resolve));
  const markup=target.innerHTML.slice(target.innerHTML.indexOf('<dialog'));
  assert.doesNotMatch(markup,/data-verification-form="record_previous_interview"|Edit Previous Interview/);
  assert.match(markup,/data-verification-form="record_interview_outcome"/);
});

test('historical follow-up retains source and date in history while offering a real new appointment', async t => {
  const interview=historicalInterview({outcome:'follow_up'});
  const {ui}=installUi(t,{responsePayload:call=>call.url.includes('talent-verification')?interviewPayload(interview,{interviewHistory:[historicalInterview({interviewId:'55555555-5555-4555-8555-555555555555'})]}):queuePayload('admin',[applicant({stage:'in_review'})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(resolve=>setImmediate(resolve));
  ui.openVerification(applicantId,'interview');await new Promise(resolve=>setImmediate(resolve));
  assert.match(target.innerHTML,/data-verification-form="schedule_follow_up_interview"/);
  assert.match(target.innerHTML,/Previous Interview Completed · Recorded Manually/);
  assert.match(target.innerHTML,/Aug 15, 2026/);
  assert.match(target.innerHTML,/✓ Interview Complete/,'a completed historical follow-up recommendation still addresses the interview requirement');
});

test('historical date and interviewer controls remain top aligned with equal input heights',()=>{
  const css=read('operations/talent-review-queue.css');
  assert.match(css,/\.talent-interview-previous-form \.talent-verification-form-grid \{[^}]*align-items: start/);
  assert.match(css,/\.talent-interview-previous-form label \{[^}]*align-content: start/);
  assert.match(css,/\.talent-interview-previous-form input,\s*\.talent-interview-previous-form select \{ height: 44px; min-height: 44px; \}/);
});

test('only the actual Admin and Talent Management roles can open or load the queue', async t => {
  const { ui, calls } = installUi(t, { role: 'sales' });

  assert.equal(ui.canUse('admin'), true);
  assert.equal(ui.canUse('talent_management'), true);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant', '']) {
    assert.equal(ui.canUse(role), false, `${role || 'empty role'} must be denied`);
  }

  await ui.refresh();
  assert.equal(calls.length, 0);
  assert.equal(ui.currentQueue().phase, 'idle');

  globalThis.soroCurrentAccess = { role: 'admin' };
  await ui.refresh();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/.netlify/functions/talent-review-queue');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.body, undefined);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-review-token');
});

test('normalization enforces the server viewer role and an exact public applicant allowlist', t => {
  const { ui } = installUi(t);
  const payload = queuePayload('admin', [applicant({
    organizationId: '55555555-5555-4555-8555-555555555555',
    birthDate: '1998-01-10',
    address: 'Private address',
    statusReason: 'Private internal reason',
    owner: { id: ownerId, name: 'Jordan Reed', email: 'jordan-private@example.com' },
    checklist: [{ key: 'core_profile', label: 'Core profile', state: 'complete', internalProof: 'private' }]
  })]);

  const normalized = ui.normalizePayload(payload, 'admin');
  assert.equal(normalized.phase, 'ready');
  assert.deepEqual(Object.keys(normalized.applicants[0]).sort(), [...APPLICANT_KEYS].sort());
  assert.deepEqual(Object.keys(normalized.applicants[0].owner).sort(), ['id', 'name']);
  assert.deepEqual(Object.keys(normalized.applicants[0].resume).sort(), ['available', 'label']);
  assert.deepEqual(Object.keys(normalized.applicants[0].checklist[0]).sort(), ['key', 'label', 'state']);
  assert.equal(JSON.stringify(normalized).includes('Private address'), false);
  assert.equal(JSON.stringify(normalized).includes('Private internal reason'), false);
  assert.equal(JSON.stringify(normalized).includes('jordan-private@example.com'), false);
  assert.throws(() => ui.normalizePayload(payload, 'talent_management'), /access|role|Talent review/i);
});

test('resume metadata is canonical and never carries a storage path or URL into queue state', t => {
  const { ui } = installUi(t);
  const normalized = ui.normalizePayload(queuePayload('admin', [applicant({
    resume: {
      available: true,
      label: 'private/org/applicant/resume.pdf',
      storagePath: 'private/org/applicant/resume.pdf',
      signedUrl: 'https://storage.example/signed',
      documentId: requestId,
      fileName: 'resume.pdf'
    }
  })]), 'admin');

  assert.deepEqual(normalized.applicants[0].resume, { available: true, label: 'Secure résumé available' });
  assert.doesNotMatch(JSON.stringify(normalized), /private\/org|storage\.example|resume\.pdf|storagePath|signedUrl|documentId|fileName/i);
});

test('a real zero queue stays zero without sample applicants or counts', t => {
  const { ui } = installUi(t, { responsePayload: queuePayload('admin', []) });
  const normalized = ui.normalizePayload(queuePayload('admin', []), 'admin');

  assert.deepEqual(normalized.summary, {
    all: 0, submitted: 0, in_review: 0, needs_more_info: 0, bench_ready: 0, closed: 0
  });
  assert.deepEqual(normalized.applicants, []);
  assert.doesNotMatch(JSON.stringify(normalized), /Mariel|Jordan|sample|demo/i);
});

test('stage and search filters are conjunctive and Closed includes declined or archived records', async t => {
  const rows = [
    applicant(),
    applicant({ applicantId: '55555555-5555-4555-8555-555555555555', fullName: 'Cruz, Alex', preferredName: 'Alex', email: 'alex@example.com', stage: 'in_review', allowedActions: ['request_more_info', 'mark_bench_ready'] }),
    applicant({ applicantId: '66666666-6666-4666-8666-666666666666', fullName: 'Reyes, Casey', email: 'casey@example.com', stage: 'declined', allowedActions: ['reopen', 'archive'] }),
    applicant({ applicantId: '77777777-7777-4777-8777-777777777777', fullName: 'Flores, Jamie', email: 'jamie@example.com', stage: 'needs_more_info', archived: true, allowedActions: ['restore'] })
  ];
  const { ui } = installUi(t, { responsePayload: queuePayload('admin', rows) });
  await ui.refresh();

  ui.setStageFilter('closed');
  assert.deepEqual(ui.visibleApplicants().map(row => row.fullName), ['Reyes, Casey', 'Flores, Jamie']);
  ui.setSearch('jamie');
  assert.deepEqual(ui.visibleApplicants().map(row => row.fullName), ['Flores, Jamie']);
  ui.setStageFilter('in_review');
  assert.deepEqual(ui.visibleApplicants(), []);
  ui.setSearch('alex');
  assert.deepEqual(ui.visibleApplicants().map(row => row.fullName), ['Cruz, Alex']);
});

test('a review action posts only the exact optimistic-concurrency contract', async t => {
  const { ui, calls } = installUi(t);
  await ui.refresh();
  await ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'begin_review', note: '' });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, '/.netlify/functions/talent-review-queue');
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer signed-in-review-token');
  assert.equal(calls[1].options.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    requestId,
    applicantId,
    expectedUpdatedAt: updatedAt,
    action: 'begin_review',
    note: ''
  });
});

test('client-chosen roles, stale omission, unavailable actions, and missing required notes fail before POST', async t => {
  const { ui, calls } = installUi(t);
  await ui.refresh();
  const baseline = calls.length;

  await assert.rejects(() => ui.changeApplicant({ applicantId, action: 'begin_review', note: '' }), /incomplete|Refresh/i);
  await assert.rejects(() => ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'restore', note: '' }), /not currently available/i);
  await assert.rejects(() => ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'request_more_info', note: '' }), /message to send/i);
  globalThis.soroCurrentAccess = { role: 'client_admin' };
  await assert.rejects(() => ui.changeApplicant({ applicantId, expectedUpdatedAt: updatedAt, action: 'begin_review', note: '', role: 'admin' }), /Only Admin|Talent Management/i);
  assert.equal(calls.length, baseline);
});

test('the live dashboard metric uses the normalized queue instead of the old sample count', t => {
  const { ui } = installUi(t);
  const queue = ui.normalizePayload(queuePayload('talent_management', [
    applicant(),
    applicant({ applicantId: '55555555-5555-4555-8555-555555555555', fullName: 'Cruz, Alex', stage: 'needs_more_info', archived: false })
  ]), 'talent_management');

  assert.deepEqual(ui.dashboardMetric(['Talent Review Queue', '12', '5 interview ready', ''], 'talent_management', queue), [
    'Talent Review Queue', '2', '1 new · 1 need information', 'warning'
  ]);
  assert.deepEqual(ui.dashboardMetric(['Talent Review Queue', '12', 'sample', ''], 'sales', queue), [
    'Talent Review Queue', '12', 'sample', ''
  ]);
});

test('resume open dispatches only an authorized available applicant id', async t => {
  const missingId = '55555555-5555-4555-8555-555555555555';
  const rows = [
    applicant(),
    applicant({ applicantId: missingId, fullName: 'Cruz, Alex', email: 'alex@example.com', resume: { available: false, label: 'Résumé not attached' } })
  ];
  const { ui, events } = installUi(t, { responsePayload: queuePayload('admin', rows) });
  await ui.refresh();
  events.length = 0;

  assert.equal(ui.openResume(applicantId), true);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'soro:talent-review-open-resume');
  assert.deepEqual(events[0].detail, { applicantId });
  assert.equal(JSON.stringify(events[0]).includes('storage'), false);
  assert.equal(JSON.stringify(events[0]).includes('http'), false);

  assert.equal(ui.openResume(missingId), false);
  assert.equal(ui.openResume('66666666-6666-4666-8666-666666666666'), false);
  globalThis.soroCurrentAccess = { role: 'sales' };
  assert.equal(ui.openResume(applicantId), false);
  assert.equal(events.length, 1);
});

test('the portal opens review resumes only through the same-organization private document flow', () => {
  const operations = read('operations/operations.js');
  const start = operations.indexOf('async function openTalentReviewResume');
  const end = operations.indexOf('async function importDriveFiles', start);
  assert.ok(start >= 0 && end > start, 'the secure review-resume handler must exist in the canonical portal');
  const handler = operations.slice(start, end);

  assert.match(handler, /canOpenForRole\?\.\(actualAuthenticatedRole\(\)\)/);
  assert.match(handler, /organizationId=String\(window\.soroCurrentAccess\?\.organization_id/);
  assert.match(handler, /window\.open\('','_blank'\)/);
  assert.match(handler, /viewer\.opener=null/);
  assert.match(handler, /\.from\('documents'\)/);
  assert.match(handler, /\.select\('storage_path'\)/);
  assert.match(handler, /\.eq\('organization_id',organizationId\)/);
  assert.match(handler, /\.eq\('applicant_id',id\)/);
  assert.match(handler, /\.eq\('document_type','resume'\)/);
  assert.match(handler, /\.neq\('status','rejected'\)/);
  assert.match(handler, /\.not\('storage_path','is',null\)/);
  assert.match(handler, /\.order\('created_at',\{ascending:false\}\)/);
  assert.match(handler, /\.limit\(1\)/);
  assert.match(handler, /storage\.from\('soro-private-documents'\)\.createSignedUrl\(storagePath,60\)/);
  assert.match(handler, /if\(documentError\|\|!storagePath\)throw new Error\('resume_missing'\)/);
  assert.match(handler, /viewer\.close\(\)/);
  assert.match(handler, /A secure resume is not attached to this Talent profile yet/);
  assert.doesNotMatch(handler, /innerHTML|dataset|dispatchEvent|localStorage|sessionStorage|history\.pushState/);
});

test('the canonical portal wires the queue route, profile event, navigation, and live metric opener', () => {
  const html = read('operations/index.html');
  const operations = read('operations/operations.js');
  const source = read('operations/talent-review-queue.js');
  const portalTest = read('tests/portal-workspace-preview.test.cjs');

  assert.ok(html.indexOf('talent-review-queue.js') >= 0 && html.indexOf('talent-review-queue.js') < html.indexOf('operations.js'));
  assert.match(html, /data-view="talent-review"[^>]*>[\s\S]*?Talent Review Queue[\s\S]*?id="talent-review-count"/);
  assert.match(operations, /admin\s*:\s*new Set\(\[[^\]]*'talent-review'/);
  assert.match(operations, /talent_management\s*:\s*new Set\(\[[^\]]*'talent-review'/);
  for (const role of ['sales', 'sales_management', 'billing', 'client_admin', 'client_reviewer', 'client_billing', 'virtual_assistant']) {
    const match = operations.match(new RegExp(`${role}\\s*:\\s*new Set\\(\\[([^\\]]*)\\]`, 'i'));
    if (match) assert.doesNotMatch(match[1], /talent-review/);
  }
  assert.match(operations, /soro:talent-review-open-queue/);
  assert.match(operations, /soro:talent-review-open-profile/);
  assert.match(source, /new root\.CustomEvent\('soro:talent-review-open-queue'\)/);
  assert.match(source, /new root\.CustomEvent\('soro:talent-review-open-profile'/);
  assert.match(source, /new root\.CustomEvent\('soro:talent-review-open-resume'/);
  assert.match(source, /data-review-resume="\$\{escapeHtml\(applicant\.applicantId\)\}"/);
  assert.match(source, /available \? '' : ' disabled aria-disabled="true"'/);
  assert.doesNotMatch(source, /storage_path|storagePath|signedUrl|createSignedUrl|soro-private-documents/i);
  assert.match(source, /function dashboardMetric/);
  assert.match(portalTest, /'talent-review'/, 'the exact portal allowlist test must include the new authorized view');
});

test('the review count refreshes while an authorized portal remains open', () => {
  const source = read('operations/talent-review-queue.js');
  assert.match(source, /const AUTO_REFRESH_MS = 30000/);
  assert.match(source, /addEventListener\?\.\(['"]focus['"], refreshWhenActive\)/);
  assert.match(source, /addEventListener\?\.\(['"]visibilitychange['"], refreshWhenActive\)/);
  assert.match(source, /setInterval\?\.\(refreshWhenActive, AUTO_REFRESH_MS\)/);
  assert.match(source, /reviewDialogOpen\(\)/);
  assert.match(source, /refresh\(\{ silent: true \}\)/);
  assert.match(source, /if \(silent && reviewDialogOpen\(\)\) return currentQueue\(\)/);
});

function navigationFixture() {
  const badge = { textContent: '0', hidden: true };
  const navigation = { setAttribute(name, value) { this[name] = value; } };
  const document = {
    visibilityState: 'visible', addEventListener() {}, querySelector() { return null; },
    getElementById(id) { return id === 'talent-review-count' ? badge : id === 'talent-review-nav' ? navigation : null; }
  };
  return { badge, navigation, document };
}

test('initial auth fills the sidebar badge without mounting the queue despite other page renders', async t => {
  const nav = navigationFixture();
  const { ui, calls } = installUi(t, { document: nav.document });
  const loading = ui.handleAuthChange({ detail: { session: {}, access: { role: 'admin' } } });
  assert.equal(ui.currentQueue().phase, 'loading');
  // operations.render invokes unmount on every page other than talent-review.
  for (let render = 0; render < 5; render++) ui.unmount();
  await loading;
  assert.equal(calls.length, 1);
  assert.equal(ui.currentQueue().phase, 'ready');
  assert.equal(nav.badge.textContent, '1');
  assert.equal(nav.badge.hidden, false);
  assert.match(nav.navigation['aria-label'], /1 awaiting review/);
});

test('Talent Management gets the same initial badge and a real zero remains hidden', async t => {
  const nav = navigationFixture();
  const { ui } = installUi(t, { role: 'talent_management', document: nav.document, responsePayload: queuePayload('talent_management', []) });
  await ui.handleAuthChange({ detail: { session: {}, access: { role: 'talent_management' } } });
  assert.equal(ui.currentQueue().phase, 'ready');
  assert.equal(nav.badge.textContent, '0');
  assert.equal(nav.badge.hidden, true);
});

test('logout clears shared queue and notifications even with no mounted view', async t => {
  const nav = navigationFixture();
  const { ui, events } = installUi(t, { document: nav.document });
  await ui.refresh();
  globalThis.soroCurrentAccess = null;
  await ui.handleAuthChange({ detail: { session: null, access: null } });
  assert.equal(ui.currentQueue().phase, 'idle');
  assert.equal(ui.currentQueue().applicants.length, 0);
  assert.equal(nav.badge.hidden, true);
  assert.equal(events.at(-1).detail.queue.phase, 'idle');
});

test('a late response cannot restore an old account badge after logout', async t => {
  let complete;
  const nav = navigationFixture();
  const { ui } = installUi(t, { document: nav.document, responsePayload: () => new Promise(resolve => { complete = resolve; }) });
  const loading = ui.handleAuthChange({ detail: { session: {}, access: { role: 'admin' } } });
  await new Promise(setImmediate);
  globalThis.soroCurrentAccess = null;
  await ui.handleAuthChange({ detail: { session: null, access: null } });
  complete(queuePayload());
  await loading;
  assert.equal(ui.currentQueue().phase, 'idle');
  assert.equal(ui.currentQueue().applicants.length, 0);
  assert.equal(nav.badge.hidden, true);
});

test('same-role account change discards the older pending response', async t => {
  let completeFirst;
  const nav = navigationFixture();
  const { ui } = installUi(t, { document: nav.document, responsePayload: (call, count) => count === 1 ? new Promise(resolve => { completeFirst = resolve; }) : queuePayload('admin', []) });
  globalThis.soroCurrentAccess = { role: 'admin', user_id: ownerId };
  const first = ui.handleAuthChange({ detail: { session: {}, access: globalThis.soroCurrentAccess } });
  await new Promise(setImmediate);
  globalThis.soroCurrentAccess = { role: 'admin', user_id: requestId };
  await ui.handleAuthChange({ detail: { session: {}, access: globalThis.soroCurrentAccess } });
  completeFirst(queuePayload());
  await first;
  assert.equal(ui.currentQueue().phase, 'ready');
  assert.equal(ui.currentQueue().applicants.length, 0);
  assert.equal(nav.badge.hidden, true);
});

test('leaving the queue during its first load leaves retryable state rather than stuck loading', async t => {
  let completeFirst;
  const { ui } = installUi(t, { responsePayload: (call, count) => count === 1 ? new Promise(resolve => { completeFirst = resolve; }) : queuePayload() });
  const target = { innerHTML: '', addEventListener() {}, removeEventListener() {}, querySelector() { return null; } };
  ui.mount(target);
  await new Promise(setImmediate);
  ui.unmount();
  assert.equal(ui.currentQueue().phase, 'idle');
  completeFirst(queuePayload());
  await new Promise(setImmediate);
  await ui.refresh({ silent: true });
  assert.equal(ui.currentQueue().phase, 'ready');
});

const requirementKeys = ['core_profile','resume','english','disc','enneagram','mbti','internet','equipment','skills','interview','references'];
const deferralRecord = {id:requestId,reason:'Confirm during onboarding.',createdAt:updatedAt,createdByName:'Jordan Reed',dueDate:null,taskId:null};

test('one checklist shows every Bench Ready blocker on first load and refreshes without hidden dialog gates', async t => {
  let addressed=false;
  const checklist=()=>requirementKeys.slice(0,9).map(key=>({key,label:key,state:key==='skills'?'missing':'complete',...(key==='skills'?{deferral:deferralRecord,verifiedSkillsCount:0}:{}),...(['english','disc','enneagram','mbti','internet','equipment'].includes(key)?{resultRecorded:true,evidenceState:'available'}:{})}));
  const readiness=()=>requirementKeys.map(key=>({key,status:key==='skills'?'deferred':['interview','references'].includes(key)?addressed?'complete':'pending':'complete'}));
  const {ui,calls}=installUi(t,{responsePayload:()=>queuePayload('admin',[applicant({stage:'in_review',checklist:checklist(),readiness:readiness(),allowedActions:['mark_bench_ready']})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(setImmediate);
  assert.equal(calls.length,1,'one request contains all requirement statuses');
  assert.match(target.innerHTML,/2 Remaining/);assert.match(target.innerHTML,/1 Verify Later/);
  assert.match(target.innerHTML,/Still needed: Interview, References/);
  assert.equal((target.innerHTML.match(/data-review-progress=/g)||[]).length,11);
  assert.doesNotMatch(target.innerHTML,/Applicant Submission|Team Review|class="talent-review-readiness"/);
  assert.match(target.innerHTML,/data-review-action="mark_bench_ready" disabled/);
  addressed=true;await ui.refresh({silent:true});
  assert.match(target.innerHTML,/Ready for Bench/);
  assert.doesNotMatch(target.innerHTML,/data-review-action="mark_bench_ready" disabled/);
  addressed=false;await ui.refresh({silent:true});
  assert.match(target.innerHTML,/2 Remaining/);
  assert.match(target.innerHTML,/data-review-action="mark_bench_ready" disabled/,'fresh queue replaces previously eligible cache even when timestamp is unchanged');
});

test('selecting a checklist item opens only that requirement with its direct next action',async t=>{
  const {ui}=installUi(t,{responsePayload:call=>call.url.includes('talent-review-deferrals')?requirementsPayload():queuePayload('admin',[applicant({stage:'in_review'})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(setImmediate);ui.openRequirements(applicantId,'interview');await new Promise(setImmediate);
  const dialog=target.innerHTML.slice(target.innerHTML.indexOf('<dialog'));
  assert.match(dialog,/>Interview<\/h2>/);assert.match(dialog,/Record or Schedule Interview/);
  assert.equal((dialog.match(/data-requirement-form=/g)||[]).length,1);
  assert.match(dialog,/data-requirement-form="interview"/);
  assert.doesNotMatch(dialog,/Employment references|data-requirement-form="skills"/);
});

test('readiness snapshots reject missing, duplicate, invalid and contradictory states',t=>{
  const {ui}=installUi(t);
  const readiness=requirementKeys.map(key=>({key,status:key==='resume'?'pending':'complete',privateNote:'PRIVATE'}));
  const row=applicant({readiness});
  assert.doesNotMatch(JSON.stringify(ui.normalizePayload(queuePayload('admin',[row]),'admin')),/PRIVATE/);
  for(const bad of [[],readiness.slice(1),[readiness[0],...readiness.slice(0,-1)],readiness.map(i=>({...i,status:'invented'})),readiness.map(i=>({...i,status:'complete'}))])assert.throws(()=>ui.normalizePayload(queuePayload('admin',[{...row,readiness:bad}]),'admin'),/invalid applicant/);
});
test('recorded assessment stays green while missing-file follow-up remains separate', async t => {
  const checklist=[
    {key:'english',label:'English assessment',state:'needs_review',resultRecorded:true,evidenceState:'missing',deferral:deferralRecord},
    {key:'disc',label:'DISC assessment',state:'needs_review',resultRecorded:true,evidenceState:'unclassified_available'},
    {key:'mbti',label:'Personality assessment',state:'missing',resultRecorded:false,evidenceState:'missing',deferral:deferralRecord}
  ];
  const {ui}=installUi(t,{responsePayload:queuePayload('admin',[applicant({stage:'in_review',checklist,allowedActions:['mark_bench_ready']})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(setImmediate);
  const english=target.innerHTML.match(/<li class="talent-review-progress-item is-deferred" data-review-progress="english">([\s\S]*?)<\/li>/)?.[1];
  assert.ok(english);assert.match(english,/talent-review-recorded-detail[^>]*>Result Recorded/);assert.match(english,/Verify Later/);
  assert.match(target.innerHTML,/is-pending" data-review-progress="disc"/);
  assert.match(target.innerHTML,/is-deferred" data-review-progress="mbti"/);
  assert.equal((target.innerHTML.match(/class="talent-review-recorded-detail"/g)||[]).length,2);
  assert.match(target.innerHTML,/data-review-action="mark_bench_ready" disabled/);
});
test('queue embeds the shared full-catalog picker without changing applicant reports',()=>{
  const source=read('operations/talent-review-queue.js');
  assert.match(source,/service.loadSkills\(id, \{includeCatalog:true\}\)/);
  assert.match(source,/soroTalentSkillEditor\?\.bindPicker\?\.\(form, evidence.skills\)/);
  assert.match(source,/soroTalentSkillEditor.readSelection\(form, snapshot\)/);
  assert.match(source,/Add, edit &amp; verify skills/);
  assert.doesNotMatch(source,/update\(\{\s*self_reported_skills/);
});
function requirementsPayload(overrides = {}) {
  return {applicantId,updatedAt,items:requirementKeys.map(key=>({key,label:key,status:'pending',deferral:null})),...overrides};
}

test('requirement deferrals validate all eleven requirements and expose only safe metadata', t => {
  const {ui} = installUi(t);
  const source = requirementsPayload();
  source.items[0]={...source.items[0],status:'deferred',deferral:{...deferralRecord,internalProof:'PRIVATE'}};
  assert.equal(ui.normalizeRequirementsPayload(source,applicantId).items[0].deferral.reason,deferralRecord.reason);
  assert.doesNotMatch(JSON.stringify(ui.normalizeRequirementsPayload(source,applicantId)),/PRIVATE/);
  assert.throws(()=>ui.normalizeRequirementsPayload({...source,items:source.items.slice(1)},applicantId),/invalid/);
  assert.throws(()=>ui.normalizeRequirementsPayload({...source,items:[source.items[0],...source.items.slice(0,-1)]},applicantId),/invalid/);
  assert.throws(()=>ui.normalizeRequirementsPayload(source,ownerId),/invalid/);
  assert.throws(()=>ui.normalizeRequirementsPayload({...source,items:source.items.map(item=>({...item,status:'deferred',deferral:null}))},applicantId),/invalid/);
  const normalized=ui.normalizePayload(queuePayload('admin',[applicant({checklist:[{key:'resume',label:'Resume',state:'missing',deferral:deferralRecord}]})]),'admin');
  assert.equal(normalized.applicants[0].checklist[0].state,'missing');
  assert.equal(normalized.applicants[0].checklist[0].deferral.id,requestId);
});

test('defer and restore require a reason, and follow-up tasks require a real due date', t => {
  const {ui} = installUi(t);
  const base={applicantId,expectedUpdatedAt:updatedAt,itemKey:'resume',action:'defer',reason:'  Check next week.  ',createTask:true,dueDate:'2026-09-20'};
  assert.deepEqual(ui.buildDeferralAction(base),{requestId,applicantId,expectedUpdatedAt:updatedAt,itemKey:'resume',action:'defer',reason:'Check next week.',createTask:true,dueDate:'2026-09-20'});
  assert.equal(ui.buildDeferralAction({...base,createTask:false}).dueDate,null);
  assert.deepEqual(ui.buildDeferralAction({...base,action:'restore'}),{requestId,applicantId,expectedUpdatedAt:updatedAt,itemKey:'resume',action:'restore',reason:'Check next week.',createTask:false,dueDate:null});
  for(const values of [{reason:''},{reason:'x'.repeat(501)},{dueDate:null},{dueDate:'2026-02-30'},{itemKey:'all'},{createTask:'yes'},{action:'restore',reason:''}]) assert.throws(()=>ui.buildDeferralAction({...base,...values}),/reason|date|task|Refresh/);
});

test('Review Requirements starts only after Start Review and renders per-item deferrals honestly', async t => {
  let stage='submitted';
  const {ui,calls}=installUi(t,{responsePayload:call=>{
    if(call.url.includes('talent-review-deferrals'))return requirementsPayload();
    return queuePayload('admin',[applicant({stage})]);
  }});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(setImmediate);
  assert.equal(ui.openRequirements(applicantId),false);
  assert.doesNotMatch(target.innerHTML,/data-review-requirements=/);
  stage='in_review';await ui.refresh();
  assert.match(target.innerHTML,/data-review-requirements=/);
  assert.equal(ui.openRequirements(applicantId),true);await new Promise(setImmediate);
  assert.equal(calls.at(-1).url,`/.netlify/functions/talent-review-deferrals?applicantId=${applicantId}`);
  assert.equal((target.innerHTML.match(/data-requirement-form=/g)||[]).length,11);
  assert.match(target.innerHTML,/without marking it complete/);
  assert.match(target.innerHTML,/assigned to me/);
  assert.doesNotMatch(target.innerHTML,/talent-requirement-row is-complete/);
});

test('individual deferrals permit Bench Ready without increasing received or verified counts', async t => {
  let items=requirementsPayload().items;
  const row=()=>applicant({stage:'in_review',allowedActions:['mark_bench_ready'],checklist:items.filter(item=>!['interview','references'].includes(item.key)).map(item=>({key:item.key,label:item.label,state:'missing',...(item.deferral?{deferral:item.deferral}:{}),...(['english','disc','enneagram','mbti','internet','equipment'].includes(item.key)?{resultRecorded:false,evidenceState:'missing'}:{}),...(item.key==='skills'?{verifiedSkillsCount:0}:{})}))});
  const {ui,calls}=installUi(t,{responsePayload:call=>{
    if(call.url.includes('talent-review-deferrals')) {
      if(call.options.method==='GET')return requirementsPayload({items});
      const action=JSON.parse(call.options.body);
      items=items.map(item=>item.key===action.itemKey?{...item,status:'deferred',deferral:deferralRecord}:item);
    }
    return queuePayload('admin',[row()]);
  }});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(setImmediate);
  ui.openRequirements(applicantId);await new Promise(setImmediate);
  for(const itemKey of requirementKeys) await ui.changeRequirement({applicantId,itemKey,action:'defer',reason:'Confirm during onboarding.',createTask:false});
  ui.closeRequirements();
  assert.match(target.innerHTML,/Ready for Bench/);
  assert.match(target.innerHTML,/11 Verify Later/);
  assert.match(target.innerHTML,/No Skills Verified/);
  assert.doesNotMatch(target.innerHTML,/data-review-action="mark_bench_ready" disabled/);
  assert.doesNotMatch(target.innerHTML,/talent-review-progress-item is-recorded/);
  assert.match(target.innerHTML,/is-deferred/);
  assert.equal(ui.currentQueue().applicants[0].stage,'in_review');
  const posted=JSON.parse(calls.find(call=>call.options.method==='POST').options.body);
  assert.deepEqual(Object.keys(posted).sort(),['requestId','applicantId','expectedUpdatedAt','itemKey','action','reason','dueDate','createTask'].sort());
  assert.equal(posted.dueDate,null);
});

test('saving a requirement blocks duplicate submits, close, and stage changes until completion', async t => {
  let finish;
  const {ui,calls}=installUi(t,{responsePayload:call=>{
    if(call.url.includes('talent-review-deferrals'))return call.options.method==='POST'?new Promise(resolve=>{finish=resolve;}):requirementsPayload();
    return queuePayload('admin',[applicant({stage:'in_review',allowedActions:['mark_bench_ready']})]);
  }});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(setImmediate);ui.openRequirements(applicantId);await new Promise(setImmediate);
  const values={applicantId,itemKey:'resume',action:'defer',reason:'Confirm later.',createTask:false};
  const save=ui.changeRequirement(values);await new Promise(setImmediate);
  await assert.rejects(()=>ui.changeRequirement(values),/wait/);
  await assert.rejects(()=>ui.changeApplicant({applicantId,expectedUpdatedAt:updatedAt,action:'mark_bench_ready'}),/wait/);
  assert.equal(ui.closeRequirements(),false);
  assert.equal(calls.filter(call=>call.options.method==='POST').length,1);
  finish(queuePayload('admin',[applicant({stage:'in_review'})]));await save;
  assert.equal(ui.closeRequirements(),true);
});

test('restoring an unresolved Bench Ready requirement warns about In Review and preserves the follow-up task status', async t => {
  const items=requirementsPayload().items.map(item=>item.key==='resume'?{...item,status:'deferred',deferral:{...deferralRecord,taskId:ownerId,dueDate:'2026-09-20'}}:item);
  const {ui}=installUi(t,{responsePayload:call=>call.url.includes('talent-review-deferrals')?requirementsPayload({items}):queuePayload('admin',[applicant({stage:'bench_ready'})])});
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(){return null;}};
  ui.mount(target);await new Promise(setImmediate);ui.openRequirements(applicantId);await new Promise(setImmediate);
  assert.match(target.innerHTML,/will return to In Review/);
  assert.match(target.innerHTML,/follow-up task will be kept with its current status/);
  assert.doesNotMatch(target.innerHTML,/follow-up task will remain open/);
  assert.match(target.innerHTML,/Reason for restoring/);
  assert.match(target.innerHTML,/data-requirement-open-task=/);
  assert.match(target.innerHTML,/Restore Requirement/);
});

test('a saved restore replaces cached readiness even when its follow-up request fails', async t => {
  let restored=false;
  const row=()=>applicant({stage:'in_review',allowedActions:['mark_bench_ready'],
    checklist:requirementKeys.slice(0,9).map(key=>({key,label:key,state:key==='skills'?'missing':'complete',...(key==='skills'?{deferral:deferralRecord}: {})})),
    readiness:requirementKeys.map(key=>({key,status:key==='skills'?'deferred':key==='interview'&&restored?'pending':'complete'}))});
  const items=requirementKeys.map(key=>({key,label:key,status:key==='skills'?'deferred':'complete',deferral:key==='skills'?deferralRecord:null}));
  // Initially Interview is deferred as well, so all eleven requirements are addressed.
  items.find(item=>item.key==='interview').status='deferred';
  items.find(item=>item.key==='interview').deferral=deferralRecord;
  const {ui}=installUi(t,{responsePayload:call=>{
    if(call.url.includes('talent-review-deferrals')) {
      if(call.options.method==='POST'){restored=true;return queuePayload('admin',[row()]);}
      if(restored)throw new Error('Follow-up reload failed');
      return requirementsPayload({items});
    }
    const initial=row();initial.readiness.find(item=>item.key==='interview').status='deferred';
    return queuePayload('admin',[initial]);
  }});
  let focusSelector='';
  const target={innerHTML:'',addEventListener(){},removeEventListener(){},querySelector(selector){return selector.startsWith('[data-review-requirements=')?{focus(options){focusSelector=selector;assert.equal(options.preventScroll,true);}}:null;}};
  ui.mount(target);await new Promise(setImmediate);
  assert.match(target.innerHTML,/Ready for Bench/);
  ui.openRequirements(applicantId,'interview');await new Promise(setImmediate);
  await assert.rejects(()=>ui.changeRequirement({applicantId,itemKey:'interview',action:'restore',reason:'Record the actual outcome.',createTask:false}),/Follow-up reload failed/);
  ui.closeRequirements();
  assert.match(target.innerHTML,/1 Remaining/);
  assert.match(target.innerHTML,/Still needed: Interview/);
  assert.match(target.innerHTML,/data-review-action="mark_bench_ready" disabled/);
  assert.doesNotMatch(target.innerHTML,/Ready for Bench/);
  assert.equal(focusSelector,`[data-review-requirements="${applicantId}"][data-review-item="interview"]`);
});
