'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const id='22222222-2222-4222-8222-222222222222',org='33333333-3333-4333-8333-333333333333',user='44444444-4444-4444-8444-444444444444',referenceId='55555555-5555-4555-8555-555555555555';
const stamp='2026-09-14T12:00:00.000Z',tick=()=>new Promise(setImmediate),copy=value=>JSON.parse(JSON.stringify(value));
const decode=value=>String(value||'').replace(/&quot;/g,'"').replace(/&#0?39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
function node(properties={}){
 const listeners=new Map();
 return{disabled:false,hidden:false,isConnected:true,scrollTop:0,...properties,listeners,
  addEventListener(type,fn){listeners.set(type,fn);},removeEventListener(type,fn){if(listeners.get(type)===fn)listeners.delete(type);},
  setAttribute(){},removeAttribute(){},focus(){},emit(type,event={}){return listeners.get(type)?.({target:this,preventDefault(){},...event});}};
}
// A small fixture for the selectors these three modules use. It parses their
// actual generated form markup, preserving node identity across queue renders.
function skillForm(html,owner){
 const controls=[];
 for(const match of html.matchAll(/<(input|select|button)\b([^>]*)>/g)){
  const tag=match[1],attrs=match[2],attr=name=>decode(new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1]);
  controls.push(node({tag,name:attr('name'),value:attr('value'),type:attr('type'),checked:/\bchecked(?:\s|$)/.test(attrs),disabled:/\bdisabled(?:\s|$)/.test(attrs),ariaLabel:attr('aria-label')}));
 }
 const fields=[...html.matchAll(/data-skill-group="([^"]*)"/g)].map(match=>node({dataset:{skillGroup:decode(match[1])}}));
 const rows=new Map([...html.matchAll(/data-skill-index="(\d+)"/g)].map(match=>[match[1],node()]));
 const selected=node({textContent:''}),visible=node({textContent:''}),empty=node(),status=node({textContent:''}),list=node();
 const lookup=selector=>{
  const named=/^\[name="([^"]*)"\]$/.exec(selector);if(named)return controls.find(control=>control.name===named[1])||null;
  const indexed=/^\[data-skill-index="(\d+)"\]$/.exec(selector);if(indexed)return rows.get(indexed[1])||null;
  if(selector==='[data-skill-selected]')return selected;if(selector==='[data-skill-visible]')return visible;if(selector==='[data-skill-no-results]')return empty;
  return null;
 };
 const picker=node({matches:selector=>selector==='[data-skill-picker]',querySelector:lookup,querySelectorAll(selector){
  if(selector==='[name="verified_skill"]:checked')return controls.filter(control=>control.name==='verified_skill'&&control.checked);
  if(selector==='[data-skill-group]')return fields;return[];
 }});
 const form=node({html,picker,controls,status,elements:Object.fromEntries(controls.filter(control=>control.name).map(control=>[control.name,control])),
  closest:selector=>selector==='[data-review-skills-form]'?form:selector==='[data-review-skills-panel]'?owner.panel:null,
  querySelector(selector){if(selector==='[data-skill-picker]')return picker;if(selector==='.profile-skill-editor-list')return list;if(selector==='[data-review-skills-status]'||selector==='[role="status"]')return status;if(selector==='[type="submit"]')return controls.find(control=>control.type==='submit');return lookup(selector);},
  querySelectorAll(selector){if(selector.includes('button')||selector.includes('input,')||selector==='input')return controls;return picker.querySelectorAll(selector);},
  replaceWith(previous){owner.form=previous;previous.isConnected=true;for(const control of previous.controls)control.isConnected=true;form.isConnected=false;}
 });
 return form;
}
function makeBody(html=''){
 const body=node({form:null,querySelector:selector=>selector==='[data-review-skills-form]'?body.form:null});
 let content='';
 Object.defineProperty(body,'innerHTML',{get:()=>content,set:value=>{
  content=value;if(body.form){body.form.isConnected=false;for(const control of body.form.controls)control.isConnected=false;}
  const match=/<form data-review-skills-form>[\s\S]*?<\/form>/.exec(value);body.form=match?skillForm(match[0],body):null;
 }});
 body.innerHTML=html;return body;
}
function makeDialog(html){
 const body=makeBody(html),workspace=node(),resume=node();let resumeHtml='';
 Object.defineProperty(resume,'innerHTML',{get:()=>resumeHtml,set:value=>{resumeHtml=value;}});
 const panel={querySelector:selector=>body.form?.querySelector(selector)||null};body.panel=panel;Object.defineProperty(panel,'innerHTML',{get:()=>body.form?.html||'',set:value=>{body.innerHTML=value;}});
 const dialog=node({body,panel,resume,workspace,open:true,dataset:{verificationOwner:id,verificationMode:'verification'},
  matches:selector=>selector==='[data-verification-dialog]',showModal(){this.open=true;},
  querySelector(selector){if(selector==='.talent-verification-body')return body;if(selector==='.talent-verification-workspace')return workspace;return null;},
  querySelectorAll:()=>body.form?.controls||[]});
 return dialog;
}
function documentFixture(){
 const target=node({dialog:null,querySelector(selector){
  if(selector==='[data-verification-dialog]'||selector==='[data-review-dialog], [data-verification-dialog], [data-requirements-dialog]')return target.dialog;
  if(selector==='[data-review-skills-form]')return target.dialog?.body.form||null;
  if(selector==='[data-review-skills-panel]')return target.dialog?.panel||null;
  if(selector==='[data-review-resume-panel]')return target.dialog?.resume||null;
  if(selector==='.talent-verification-body')return target.dialog?.body||null;
  return null;
 },querySelectorAll:()=>[]});
 let content='';Object.defineProperty(target,'innerHTML',{get:()=>content,set:value=>{content=value;target.dialog=value.includes('data-verification-dialog')?makeDialog(value):null;}});
 const document={visibilityState:'visible',addEventListener(){},getElementById:()=>null,querySelector:selector=>selector.includes('[open]')?target.dialog:null,
  createElement(tag){assert.equal(tag,'template');const template={content:null};Object.defineProperty(template,'innerHTML',{set:value=>{const dialog=makeDialog(value);template.content={querySelector:selector=>selector==='.talent-verification-body'?dialog.body:null};}});return template;}};
 return{target,document};
}
function harness(t,initial={}){
 const dom=documentFixture(),queries=[],requests=[],events=new Map();let saveWait=null,revision=0;
 let record={id,organization_id:org,updated_at:stamp,self_reported_skills:[],verified_skills:[],legacy_application_data:{keep:'original import'},...initial};
 let references=[{referenceId,name:'Sample reference',outcome:'pending',phone:'',email:'',company:'Sample',relationship:'Supervisor',attempts:[],updatedAt:stamp}];
 const context={...dom,console,URL,Date,Intl,AbortController,setTimeout,clearTimeout,crypto:webcrypto,setInterval(){},scrollTo(){},scrollBy(){},confirm:()=>true,
  CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail;}},
  addEventListener(type,fn){events.set(type,fn);},dispatchEvent(event){events.get(event.type)?.(event);},
  soroCurrentAccess:{role:'talent_management',user_id:user,organization_id:org,active:true},
  soroTalentSkillCatalog:{getGroups:()=>[{id:'general',label:'General support',skills:[{name:'Calendar management'},{name:'Email support'}]}]}
 };
 function applicant(){return{applicantId:id,fullName:'Legacy Applicant',email:'legacy@example.test',updatedAt:record.updated_at,applicationReceivedAt:stamp,stage:'in_review',archived:false,owner:{id:user,name:'Reviewer'},resume:{available:true},checklist:[{key:'skills',label:'Skills',state:record.verified_skills.length?'complete':'missing',verifiedSkillsCount:record.verified_skills.length}],allowedActions:['mark_bench_ready']};}
 function queuePayload(){return{generatedAt:stamp,viewerRole:context.soroCurrentAccess.role,summary:{all:1,submitted:0,in_review:1,needs_more_info:0,bench_ready:0,closed:0},applicants:[applicant()]};}
 function verificationPayload(){return{generatedAt:stamp,viewerRole:context.soroCurrentAccess.role,applicant:applicant(),gate:{interviewAddressed:false,referencesAddressed:false,benchReadyEligible:false,blockers:['Interview pending']},interview:null,interviewHistory:[],references,interviewers:[],availableAttendees:[],calendarIntegration:{configured:false,organizerLabel:''}};}
 context.fetch=async(url,options={})=>{requests.push({url,options});if(url.includes('talent-verification')&&options.method==='POST'){assert.equal(JSON.parse(options.body).action,'remove_reference');references=[];}const payload=url.includes('talent-verification')?verificationPayload():queuePayload();return{ok:true,status:200,text:async()=>JSON.stringify(payload)};};
 context.soroSupabase={supabaseUrl:'https://test.supabase.co',auth:{getSession:async()=>({data:{session:{access_token:'sample-only',user:{id:user}}}})},
  from(table){const call={table,filters:[]};queries.push(call);const query={select(){return query;},eq(name,value){call.filters.push([name,value]);return query;},is(){return query;},neq(){return query;},not(){return query;},order(){return query;},limit(){return query;},range(){return query;},update(value){call.update=copy(value);return query;},
   async maybeSingle(){if(call.update){if(saveWait)await saveWait;assert.ok(call.filters.some(([name,value])=>name==='updated_at'&&value===record.updated_at),'Save must use the latest optimistic concurrency value.');record={...record,...copy(call.update),updated_at:new Date(Date.parse(stamp)+ ++revision*1000).toISOString()};}return{data:copy(record),error:null};},
   then(resolve,reject){return Promise.resolve({data:table==='skill_library'?[{name:'Custom CRM',is_active:true}]:[{file_name:'Resume.txt',storage_path:'applicants/sample/resume.txt'}],error:null}).then(resolve,reject);}};return query;},
  storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:'https://test.supabase.co/storage/v1/object/sign/soro-private-documents/applicants/sample/resume.txt?token=sample'}})})}
 };
 vm.createContext(context);
 for(const file of ['talent-skill-editor.js','talent-review-evidence.js','talent-review-queue.js'])vm.runInContext(fs.readFileSync('operations/'+file,'utf8'),context,{filename:file});
 const api=context.soroTalentReviewQueue;
 t.after(()=>api.unmount({reset:true}));
 return{context,api,...dom,queries,requests,get record(){return copy(record);},get form(){return dom.target.dialog?.body.form;},
  async open(){assert.equal(api.mount(dom.target),true);await tick();assert.equal(api.openVerification(id),true);await tick();await tick();assert.ok(this.form,'Full catalog form should render after protected reads.');},
  select(name,years=''){const input=this.form.controls.find(control=>control.ariaLabel==='Verify '+name);assert.ok(input,'Expected catalog entry: '+name);input.checked=true;this.form.picker.emit('change',{target:input});this.form.elements['skill_years_'+input.value].value=years;return input;},
  async save(){await dom.target.emit('submit',{target:this.form});await tick();},
  deferSave(){let release;saveWait=new Promise(resolve=>{release=resolve;});return()=>{saveWait=null;release();};},
  async removeReference(){const button=node({closest:selector=>selector==='[data-verification-reference]'?{dataset:{verificationReference:referenceId}}:null});await dom.target.emit('click',{target:{closest:selector=>selector==='[data-verification-remove-reference]'?button:null}});await tick();}
 };
}

test('queue opens the full catalog for a blank legacy application and saves beside the same resume',async t=>{
 const h=harness(t);await h.open();
 assert.match(h.form.html,/data-skill-picker/);assert.match(h.form.html,/Custom CRM/);
 assert.equal(h.form.controls.filter(control=>control.name==='verified_skill').length,3);
 assert.equal(h.form.controls.some(control=>control.checked),false);
 assert.ok(h.queries.some(query=>query.table==='skill_library'));
 const dialog=h.target.dialog,resume=dialog.resume;
 assert.match(resume.innerHTML,/Applicant résumé/);
 h.select('Calendar management','0');await h.save();
 assert.deepEqual(h.record.verified_skills,['Calendar management']);assert.deepEqual(h.record.self_reported_skills,[]);
 assert.deepEqual(h.record.legacy_application_data,{keep:'original import',verified_skill_experience:{'Calendar management':0}});
 assert.equal(h.target.dialog,dialog);assert.equal(h.target.dialog.resume,resume);
 h.select('Custom CRM','2.5');await h.save();
 assert.deepEqual(h.record.verified_skills,['Calendar management','Custom CRM']);
 assert.equal(h.queries.filter(query=>query.update).length,2);
 assert.equal(h.queries.some(query=>query.update&&Object.hasOwn(query.update,'self_reported_skills')),false);
});

test('after an unverified legacy-only row disappears, a second save uses fresh picker indices',async t=>{
 const h=harness(t,{verified_skills:['Legacy A','Legacy B'],legacy_application_data:{keep:'untouched',verified_skill_experience:{'Legacy A':1,'Legacy B':4}}});await h.open();
 const first=h.form.controls.find(control=>control.ariaLabel==='Verify Legacy A');first.checked=false;h.form.picker.emit('change',{target:first});
 await h.save();assert.deepEqual(h.record.verified_skills,['Legacy B']);
 assert.doesNotMatch(h.form.html,/Verify Legacy A/);
 h.select('Legacy B','6');await h.save();
 assert.deepEqual(h.record.verified_skills,['Legacy B']);assert.equal(h.record.legacy_application_data.verified_skill_experience['Legacy B'],6);
});

test('reference updates retain unsaved skill choices, search, experience and resume nodes',async t=>{
 const h=harness(t);await h.open();h.select('Custom CRM','3.5');
 const form=h.form,resume=h.target.dialog.resume,search=form.elements.skill_search;search.value='CRM';search.emit('input');h.target.dialog.body.scrollTop=180;
 await h.removeReference();
 assert.equal(h.form,form);assert.equal(h.target.dialog.resume,resume);assert.equal(h.target.dialog.body.scrollTop,180);
 assert.equal(h.form.elements.skill_search.value,'CRM');
 const selected=h.context.soroTalentSkillEditor.readSelection(h.form,{catalog:h.context.soroTalentSkillCatalog.getGroups().concat([{id:'library',label:'Additional library skills',skills:[{name:'Custom CRM'}]}]),record:h.record});
 assert.deepEqual(copy(selected),[{name:'Custom CRM',years:'3.5'}]);
 assert.equal(h.queries.filter(query=>query.update).length,0);
 await h.save();assert.deepEqual(h.record.verified_skills,['Custom CRM']);
});

test('pending skill saves disable editing and duplicate submissions without losing selected years',async t=>{
 const h=harness(t);await h.open();h.select('Calendar management','1');const form=h.form,release=h.deferSave();
 const saving=h.save();await tick();
 assert.equal(form.controls.every(control=>control.disabled),true);
 await h.target.emit('submit',{target:form});assert.equal(h.queries.filter(query=>query.update).length,1);
 release();await saving;assert.equal(h.record.legacy_application_data.verified_skill_experience['Calendar management'],1);
 assert.equal(h.form.querySelector('[type="submit"]').disabled,false);
});

test('Sales and Talent roles cannot open queue verification or send an inline skill save',async t=>{
 const h=harness(t);h.context.soroCurrentAccess.role='sales';
 assert.equal(h.api.mount(h.target),false);assert.equal(h.api.openVerification(id),false);assert.equal(h.queries.length,0);
 h.context.soroCurrentAccess.role='talent_management';await h.open();h.select('Calendar management','1');
 for(const role of ['sales','virtual_assistant','client_admin']){h.context.soroCurrentAccess.role=role;await h.save();assert.equal(h.queries.filter(query=>query.update).length,0);}
});
