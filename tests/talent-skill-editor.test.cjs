const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const api=require('../operations/talent-skill-editor.js');
const source=fs.readFileSync(require.resolve('../operations/talent-skill-editor.js'),'utf8');
const taxonomy=fs.readFileSync(require.resolve('../operations/talent-directory-filters.js'),'utf8');
const areas=vm.runInNewContext(taxonomy.match(/var WORK_AREAS = (\[[\s\S]*?\n    \]);/)[1]);
function snapshot(){return {catalog:areas.map(a=>({id:a.id,label:a.label,skills:a.skills.map(s=>({name:s[1]}))})),record:{self_reported_skills:[],verified_skills:[],legacy_application_data:{}}};}
test('all 50 canonical application skills are selectable in their five work types',()=>{
 const state=snapshot(),groups=api.buildGroups(state),html=api.markup(state,'Example Talent');
 assert.equal(groups.length,5);assert.equal(groups.flatMap(g=>g.skills).length,50);
 assert.equal((html.match(/name="verified_skill"/g)||[]).length,50);
 assert.match(html,/Medical coding support/);assert.match(html,/All work types/);
 assert.equal(groups.flatMap(g=>g.skills).every((e,i)=>e.index===i),true);
});
test('reported, verified and custom skills stay distinct without duplicate rows',()=>{
 const state=snapshot(),name=state.catalog[0].skills[0].name;
 state.catalog.push({id:'library',label:'Additional library skills',skills:[{name:name.toUpperCase()},{name:'Special software'}]});
 state.record.self_reported_skills=[name,'Legacy expertise'];
 state.record.verified_skills=['Legacy expertise','Special software'];
 const groups=api.buildGroups(state),entries=groups.flatMap(g=>g.skills);
 assert.equal(entries.length,52);
 assert.equal(entries.find(e=>e.name===name).reported,true);
 assert.equal(entries.find(e=>e.name===name).verified,false);
 assert.equal(entries.find(e=>e.name==='Legacy expertise').verified,true);
 assert.equal(groups.at(-1).label,'Other recorded skills');
});
test('experience can remain blank or zero and unselected inputs are disabled',()=>{
 const state=snapshot(),first=state.catalog[0].skills[0].name,second=state.catalog[0].skills[1].name;
 state.record.verified_skills=[first,second];state.record.legacy_application_data.verified_skill_experience={[first]:0};
 const html=api.markup(state,'Example');
 assert.match(html,/name="skill_years_0"[^>]*value="0"/);
 assert.match(html,/name="skill_years_1"[^>]*value=""/);
 assert.match(html,/name="skill_years_2"[^>]*disabled/);
 assert.match(html,/Applicant-reported answers stay unchanged/);
 assert.doesNotMatch(html,/required/);
});
test('legacy verified capitalization variants retain both exact names and experience values',()=>{
 const state=snapshot();state.record.verified_skills=['Scheduling','scheduling'];
 state.record.legacy_application_data.verified_skill_experience={Scheduling:5,scheduling:2};
 const entries=api.buildGroups(state).flatMap(g=>g.skills).filter(e=>e.verified),html=api.markup(state,'Example');
 assert.deepEqual(entries.map(e=>e.name),['Scheduling','scheduling']);
 for(const [index,value]of [[entries[0].index,5],[entries[1].index,2]])assert.match(html,new RegExp(`name="skill_years_${index}"[^>]*value="${value}"`));
});
test('search matches skill or work type and combines with the selected group',()=>{
 const group={id:'healthcare',label:'Medical & healthcare support'},entry={name:'Patient scheduling'};
 assert.equal(api.matches(entry,group,' medical ','healthcare'),true);
 assert.equal(api.matches(entry,group,'PATIENT',''),true);
 assert.equal(api.matches(entry,group,'patient','social_media'),false);
 assert.equal(api.matches(entry,group,'nonsense',''),false);
});
test('untrusted skill names and display names are escaped',()=>{
 const state=snapshot();state.record.verified_skills=['<img src=x onerror=alert(1)>'];
 const html=api.markup(state,'<script>alert(1)</script>');
 assert.doesNotMatch(html,/<img|<script/);assert.match(html,/&lt;img/);
});
test('profile loads fresh full catalog through protected evidence and keeps hidden selections at save',()=>{
 const integration=fs.readFileSync(require.resolve('../operations/operations-enhancements.js'),'utf8');
 const handler=integration.slice(integration.indexOf('function openTalentSkillReview()'),integration.indexOf('function removeOwnProfileManagementActions'));
 assert.match(handler,/canVerifyTalentSkills/);assert.match(handler,/soroTalentSkillEditor.open/);assert.doesNotMatch(handler,/\.update\(/);
 assert.match(source,/loadSkills\(applicant.id,\{includeCatalog:true\}\)/);
 assert.match(source,/querySelectorAll\('\[name="verified_skill"\]:checked'\)/);
 assert.match(source,/soro-auth-changed/);assert.match(source,/hashchange/);
 const html=fs.readFileSync(require.resolve('../operations/index.html'),'utf8');
 assert.ok(html.indexOf('talent-directory-filters.js')<html.indexOf('talent-skill-editor.js'));
 assert.ok(html.indexOf('talent-skill-editor.js')<html.indexOf('operations-enhancements.js'));
 assert.match(html,/talent-skill-editor.css\?v=[\w-]+/);
});

test('optional-library notice does not hide catalog or recorded legacy skills and is escaped',()=>{
 const state=snapshot();state.catalogNotice='Additional custom skills are temporarily unavailable. <script>';
 state.record.verified_skills=['Legacy expertise'];
 const html=api.markup(state,'Sample');
 assert.match(html,/class="profile-skill-editor-notice"/);
 assert.match(html,/temporarily unavailable/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal((html.match(/name="verified_skill"/g)||[]).length,51);
 assert.match(html,/Legacy expertise/);
 assert.match(html,/<button type="submit" class="button primary">Save verified skills/);
});

function node(properties={}){
 const events=new Map();
 return{hidden:false,...properties,events,addEventListener(type,listener){if(!events.has(type))events.set(type,new Set());events.get(type).add(listener);},removeEventListener(type,listener){events.get(type)?.delete(listener);},emit(type,target=this){for(const listener of events.get(type)||[])listener({target});}};
}
function pickerFixture(state){
 const groups=api.buildGroups(state),entries=groups.flatMap(group=>group.skills),years=state.record?.legacy_application_data?.verified_skill_experience||{};
 const search=node({value:''}),area=node({value:''}),selected=node({textContent:''}),visible=node({textContent:''}),empty=node();
 const rows=new Map(entries.map(entry=>[entry.index,node()]));
 const fields=groups.map(group=>node({dataset:{skillGroup:String(group.id)}}));
 const checks=entries.map(entry=>node({name:'verified_skill',value:String(entry.index),checked:entry.verified}));
 const yearInputs=new Map(entries.map(entry=>[entry.index,node({value:years[entry.name]===undefined?'':String(years[entry.name]),disabled:!entry.verified})]));
 const picker=node({
  matches:selector=>selector==='[data-skill-picker]',
  querySelectorAll(selector){if(selector==='[name="verified_skill"]:checked')return checks.filter(input=>input.checked);if(selector==='[data-skill-group]')return fields;return[];},
  querySelector(selector){
   if(selector==='[name="skill_search"]')return search;if(selector==='[name="skill_area"]')return area;
   if(selector==='[data-skill-selected]')return selected;if(selector==='[data-skill-visible]')return visible;if(selector==='[data-skill-no-results]')return empty;
   let match=/^\[data-skill-index="(\d+)"\]$/.exec(selector);if(match)return rows.get(Number(match[1]));
   match=/^\[name="skill_years_(\d+)"\]$/.exec(selector);return match?yearInputs.get(Number(match[1])):null;
  }
 });
 const form={querySelector:selector=>selector==='[data-skill-picker]'?picker:null};
 return{form,picker,search,area,selected,visible,empty,rows,fields,checks,yearInputs,entries};
}

test('inline picker embeds the full catalog for blank legacy applicants without a form or automatic verification',()=>{
 const state=snapshot(),before=JSON.stringify(state),html=api.pickerMarkup(state);
 assert.match(html,/<div class="profile-skill-picker" data-skill-picker>/);
 assert.equal((html.match(/name="verified_skill"/g)||[]).length,50);
 assert.doesNotMatch(html,/<form|<header|<footer|type="submit"|data-skill-editor-close| checked/);
 assert.match(html,/aria-label="Verify /);
 assert.match(html,/Available to verify/);
 assert.equal(JSON.stringify(state),before);
 const standalone=api.markup(state,'Sample');
 assert.equal((standalone.match(/<form/g)||[]).length,1);
 assert.equal((standalone.match(/data-skill-picker/g)||[]).length,1);
});

test('blank legacy selection becomes verified only on an explicit checkbox and does not invent reported answers',()=>{
 const state=snapshot(),before=JSON.stringify(state),ui=pickerFixture(state),binding=api.bindPicker(ui.form,state);
 assert.equal(ui.selected.textContent,'0 selected for verification');
 assert.deepEqual(binding.readSelection(),[]);
 ui.checks[3].checked=true;ui.picker.emit('change',ui.checks[3]);
 assert.equal(ui.yearInputs.get(3).disabled,false);
 ui.yearInputs.get(3).value='0';
 assert.deepEqual(api.readSelection(ui.form,state),[{name:ui.entries[3].name,years:'0'}]);
 assert.equal(ui.selected.textContent,'1 selected for verification');
 assert.equal(JSON.stringify(state),before,'Only the host save action can change a record.');
});

test('search and work type filters combine while hidden selections and exact existing years survive',()=>{
 const state=snapshot(),first=state.catalog[0].skills[0].name;
 state.record.self_reported_skills=[first];state.record.verified_skills=[first,'Legacy expertise'];
 state.record.legacy_application_data.verified_skill_experience={[first]:0,'Legacy expertise':7.5};
 const ui=pickerFixture(state),binding=api.bindPicker(ui.form,state);
 ui.search.value='LEGACY';ui.search.emit('input');
 assert.equal(ui.visible.textContent,`1 of ${ui.entries.length} skills shown`);
 assert.equal(ui.selected.textContent,'2 selected for verification');
 assert.deepEqual(binding.readSelection(),[{name:first,years:'0'},{name:'Legacy expertise',years:'7.5'}]);
 ui.area.value=state.catalog[0].id;ui.area.emit('change');
 assert.equal(ui.empty.hidden,false);
 assert.equal(ui.fields.every(field=>field.hidden),true);
 assert.equal(binding.readSelection().length,2);
 ui.search.value='';ui.search.emit('input');
 assert.equal(ui.empty.hidden,true);
 assert.equal([...ui.rows.values()].filter(row=>!row.hidden).length,state.catalog[0].skills.length);
 ui.area.value='';ui.area.emit('change');
 assert.equal(ui.fields.every(field=>!field.hidden),true);
});

test('unchecking omits a skill and disables its years without losing them before a later recheck',()=>{
 const state=snapshot(),name=state.catalog[0].skills[0].name;
 state.record.verified_skills=[name];state.record.legacy_application_data.verified_skill_experience={[name]:4};
 const ui=pickerFixture(state),binding=api.bindPicker(ui.form,state);
 ui.yearInputs.get(0).value='6.5';
 ui.checks[0].checked=false;ui.picker.emit('change',ui.checks[0]);
 assert.equal(ui.yearInputs.get(0).disabled,true);assert.equal(ui.yearInputs.get(0).value,'6.5');assert.deepEqual(binding.readSelection(),[]);
 ui.checks[0].checked=true;ui.picker.emit('change',ui.checks[0]);
 assert.equal(ui.yearInputs.get(0).disabled,false);
 assert.deepEqual(binding.readSelection(),[{name,years:'6.5'}]);
 assert.equal(state.record.legacy_application_data.verified_skill_experience[name],4);
});

test('inline readSelection rejects unknown and duplicate indexes and ignores surrounding form controls',()=>{
 const state=snapshot(),ui=pickerFixture(state);
 ui.form.querySelectorAll=()=>[{value:'9999',checked:true}];
 assert.deepEqual(api.readSelection(ui.form,state),[],'Selection is scoped to the embedded picker.');
 for(const value of ['9999','-1','NaN','0.5','1e0']){
  ui.checks.push({value,checked:true});assert.throws(()=>api.readSelection(ui.form,state),/current catalog/);ui.checks.pop();
 }
 ui.checks[0].checked=true;ui.checks.push({value:'0',checked:true});assert.throws(()=>api.readSelection(ui.form,state),/current catalog/);ui.checks.pop();
 ui.yearInputs.delete(0);assert.throws(()=>api.readSelection(ui.form,state),/experience could not be read/);
 assert.throws(()=>api.readSelection(null,state),/not ready/);
});

test('inline binding can be refreshed, safely rebound and disposed without changing a draft',()=>{
 const state=snapshot(),ui=pickerFixture(state),first=api.bindPicker(ui.picker,state);
 ui.search.value='calendar';ui.checks[0].checked=true;ui.yearInputs.get(0).value='2';
 const second=api.bindPicker(ui.form,state);
 assert.equal(first.refresh(),false);
 assert.equal(ui.search.events.get('input').size,1);assert.equal(ui.picker.events.get('change').size,1);
 assert.equal(ui.search.value,'calendar');assert.equal(ui.checks[0].checked,true);assert.equal(ui.yearInputs.get(0).value,'2');
 second.destroy();second.destroy();
 assert.equal(ui.search.events.get('input').size,0);assert.equal(ui.area.events.get('change').size,0);assert.equal(ui.picker.events.get('change').size,0);
 assert.equal(second.refresh(),false);
 assert.equal(api.bindPicker(null,state),null);
});

test('empty catalog has a truthful empty state and reusable picker styles hide filtered rows inline',()=>{
 const state={catalog:[],record:{self_reported_skills:[],verified_skills:[]}},ui=pickerFixture(state);
 api.bindPicker(ui.form,state);
 assert.equal(ui.visible.textContent,'0 of 0 skills shown');assert.equal(ui.empty.hidden,false);assert.deepEqual(api.readSelection(ui.form,state),[]);
 const css=fs.readFileSync(require.resolve('../operations/talent-skill-editor.css'),'utf8');
 assert.match(css,/\.profile-skill-picker \[hidden\]/);assert.match(css,/\.profile-skill-picker \.sr-only/);
});
