const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const ui=require('../operations/support-tickets'),api=require('../netlify/functions/support-tickets');
const clientRoles=['client_admin','client_reviewer','client_billing'];
const staffRoles=['admin','sales','sales_management','talent_management','billing'];
const clientLabels=['My account or services','Hiring or working with my VA','Signing in to my portal','Notifications and updates','Invoices or billing','Something else'];

test('Every Client role gets plain-language issues without internal Talent-profile categories',()=>{
 for(const role of clientRoles){
  const choices=ui.issueChoices(role);
  assert.deepEqual(choices.map(c=>c.label),clientLabels);
  assert.deepEqual(choices.map(c=>c.value),api.AREAS.filter(a=>a!=='Talent profiles and documents'));
  const html=ui.issueOptionsMarkup(role);
  assert.match(html,/<option value="Sales, services and client accounts">My account or services<\/option>/);
  assert.doesNotMatch(html,/>Sales, services and client accounts<|Talent profiles and documents/);
 }
});

test('Talent choices are relevant to their profile and work, not Client business administration',()=>{
 const choices=ui.issueChoices('virtual_assistant');
 assert.deepEqual(choices.map(c=>c.label),['My profile, documents or work','Signing in to my portal','Tasks, notifications and updates','Pay or account administration','Something else']);
 assert.deepEqual(choices.map(c=>c.value),api.AREAS.filter(a=>!['Sales, services and client accounts','Client records and placements'].includes(a)));
 assert.doesNotMatch(ui.issueOptionsMarkup('virtual_assistant'),/Hiring or working with my VA|My account or services/);
});

test('All five staff roles retain all seven existing category names',()=>{
 for(const role of staffRoles)assert.deepEqual(ui.issueChoices(role),api.AREAS.map(value=>({value,label:value})));
 // Returned choices cannot be used to mutate subsequent portal options.
 ui.issueChoices('admin')[0].label='Changed';
 assert.equal(ui.issueChoices('admin')[0].label,api.AREAS[0]);
});

test('All portal choices submit canonical values accepted by the unchanged ticket endpoint',()=>{
 for(const role of [...clientRoles,...staffRoles,'virtual_assistant'])for(const choice of ui.issueChoices(role)){
  const body={requestId:'10000000-0000-4000-8000-000000000001',subject:'Sample issue',details:'Sample details for local verification',area:choice.value};
  assert.equal(api.parseSubmission({body:JSON.stringify(body)}).area,choice.value);
  if(choice.label!==choice.value)assert.throws(()=>api.parseSubmission({body:JSON.stringify({...body,area:choice.label})}));
 }
});

test('Existing tickets use the viewer label, including categories hidden from new submissions',()=>{
 const ticket={area:'Talent profiles and documents',team:'talent_management',entries:[]};
 for(const role of clientRoles){
  const html=ui.detailMarkup(ticket,role);
  assert.match(html,/<dt>Issue type<\/dt><dd>My VA’s information or documents<\/dd>/);
  assert.doesNotMatch(html,/Talent profiles and documents/);
 }
 assert.match(ui.detailMarkup({...ticket,area:'Client records and placements'},'virtual_assistant'),/<dd>My client or assignment<\/dd>/);
 for(const role of staffRoles)assert.match(ui.detailMarkup(ticket,role),/<dd>Talent profiles and documents<\/dd>/);
 assert.equal(ticket.area,'Talent profiles and documents');
});

test('Unknown roles and historical categories do not expose internal names or unsafe markup',()=>{
 for(const role of [undefined,null,'outsider','client'])assert.deepEqual(ui.issueChoices(role),[]);
 assert.equal(ui.areaLabel('Internal escalation','client_admin'),'Other support question');
 assert.equal(ui.areaLabel('Internal escalation','virtual_assistant'),'Other support question');
 assert.equal(ui.areaLabel('Internal escalation',undefined),'Other support question');
 assert.equal(ui.areaLabel('Internal escalation','admin'),'Internal escalation');
 assert.equal(ui.areaLabel(null,'admin'),'Not specified');
 const unsafe={area:'<img onerror="bad">',entries:[]};
 assert.doesNotMatch(ui.detailMarkup(unsafe,'admin'),/<img/);
 assert.match(ui.detailMarkup(unsafe,'admin'),/&lt;img/);
 assert.doesNotMatch(ui.detailMarkup(unsafe,'client_admin'),/onerror/);
});

test('Help mount uses effective role; no raw categories are seeded in the form or live requests added to Admin previews',()=>{
 const source=fs.readFileSync(require.resolve('../operations/operations-enhancements.js'),'utf8');
 assert.match(source,/SoroSupportTickets\?\.mount\?\.\(root,\{role:currentAuthenticatedRole\(\)\}\)/);
 const preview=source.indexOf("if(typeof adminPreviewingNonAdminWorkspace==='function'&&adminPreviewingNonAdminWorkspace())return baseRender();");
 const mount=source.indexOf('window.SoroSupportTickets?.mount?.(root,');
 assert.ok(preview>=0&&preview<mount);
 const page=source.slice(source.indexOf('function supportPage()'),source.indexOf('function supportPage()')+4000);
 assert.doesNotMatch(page,/<option>Talent profiles and documents<\/option>/);
 const support=fs.readFileSync(require.resolve('../operations/support-tickets'),'utf8');
 assert.match(support,/area\.innerHTML=issueOptionsMarkup\(viewerRole\(\)\)/);
 assert.match(support,/area:form\.elements\.area\.value/);
});
