const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {normalizeApplicationReferences: normalize, validateReferenceConsent: validate} = require('../netlify/functions/lib/application-references');
const {compactFormData, sanitizeRawSubmission} = require('../netlify/functions/talent-application')._test;
const {publicPayload} = require('../netlify/functions/talent-verification');
const ref = { name: 'Alex Example', relationship: 'Previous Supervisor', email: 'alex@example.test', phone: '+63 555 0100' };

test('up to three optional references survive draft and raw-submission round trips', () => {
  const input = {references:[ref,{name:'',relationship:'Teacher'}, {phone:'555 0123'}],referenceContactConsent:true};
  const draft = compactFormData(input);
  assert.equal(draft.references.length,3);
  assert.deepEqual(draft.references[0],ref);
  assert.deepEqual(compactFormData(JSON.parse(JSON.stringify(draft))),draft);
  assert.deepEqual(sanitizeRawSubmission(draft),draft);
  assert.deepEqual(validate(draft),draft.references);
});
test('every reference field can stand alone; consent is conditional but strictly boolean', () => {
  assert.deepEqual(validate({}),[]);
  assert.deepEqual(validate({references:[{}],referenceContactConsent:false}),[]);
  for (const key of Object.keys(ref)) {
    const references=[{[key]:ref[key]}];
    assert.equal(validate({references,referenceContactConsent:true}).length,1);
    for(const consent of [false,undefined,'true',1]) assert.throws(()=>validate({references,referenceContactConsent:consent}),/permission box/);
  }
});
test('drafts retain unfinished reference emails but final submission validates supplied emails', () => {
  assert.equal(compactFormData({references:[{email:'unfinished@'}]}).references[0].email,'unfinished@');
  assert.throws(()=>validate({references:[{email:'unfinished@'}],referenceContactConsent:true}),/valid reference email/);
  assert.equal(validate({references:[{phone:'555'}],referenceContactConsent:true})[0].email,'');
});
test('malformed, excessive, overlong and null-byte reference data is rejected before truncation', () => {
  for(const value of [null,{},'bad',[null],['bad'],[[]],Array(4).fill(ref),[{name:'x'.repeat(161)}],[{phone:123}],[{name:'a\u0000b'}]]) assert.throws(()=>normalize(value));
  assert.deepEqual(normalize([{...ref,privateField:'never expose'}]),[ref]);
  assert.deepEqual(compactFormData({...compactFormData({references:[ref]}),references:[]}).references,[]);
});
test('submitted references are private and are not copied into matching-profile legacy data', () => {
  const source=fs.readFileSync(require.resolve('../netlify/functions/talent-application'),'utf8');
  const legacy=source.slice(source.indexOf('legacy_application_data:'),source.indexOf('uploaded_from_native_application: true'));
  assert.doesNotMatch(legacy,/references|referenceContactConsent/);
  assert.match(source,/data\.references = validateReferenceConsent\(data\)/);
  assert.match(source,/raw_submission: sanitizeRawSubmission\(data\)/);
  const html=fs.readFileSync('application/index.html','utf8');
  assert.match(html,/Optional · Up to 3/);
  assert.match(html,/Business references/);
  assert.doesNotMatch(html,/name="referenceContactConsent"[^>]*required/);
});

function state(applicationReferences) {return {generatedAt:'2026-09-14T12:00:00Z',viewerRole:'talent_management',applicant:{applicantId:'22222222-2222-4222-8222-222222222222',fullName:'Sample Talent',email:'talent@example.test',stage:'in_review',updatedAt:'2026-09-14T12:00:00Z'},gate:{interviewAddressed:false,referencesAddressed:false,benchReadyEligible:false,blockers:[]},references:[],interview:null,interviewers:[],applicationReferences};}
test('verification allowlists submitted reference details without marking anything verified', () => {
  const payload=publicPayload(state({items:[{...ref,secret:'not returned'}],contactConsent:true,submittedAt:'2026-09-14T12:00:00Z',raw_submission:'not returned'}));
  assert.deepEqual(payload.applicationReferences.items,[ref]);
  assert.equal(payload.gate.referencesAddressed,false);
  assert.deepEqual(payload.references,[]);
  assert.doesNotMatch(JSON.stringify(payload),/secret|raw_submission|not returned/);
  assert.equal(publicPayload(state(undefined)).applicationReferences,null);
  assert.throws(()=>publicPayload(state({items:[ref],contactConsent:'true',submittedAt:'2026-09-14T12:00:00Z'})));
});
