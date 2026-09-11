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
 assert.match(html,/talent-skill-editor.css\?v=20260910-legacy-library/);
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
