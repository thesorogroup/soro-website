const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('application/application.js', 'utf8');

function extract(start, end) { return source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))); }
test('public preview guards API, private drafts, persistence and direct uploads before side effects', async () => {
  let effects = 0;
  const context = {readOnlyPreview:true, previewNotice:'Preview only', fetch:()=>{effects++;},
    sessionStorage:{getItem:()=>{effects++;},setItem:()=>{effects++;},removeItem:()=>{effects++;}},
    message:()=>{}, form:{}, localPreview:false};
  const definitions = [
    extract('  const call = async', '  const updateStepNavigation'),
    extract('  const saveDraft = async', '  const resetPhoneUploadQr'),
    extract('  const uploadFile = async', '  const showMobileVideoSuccess'),
    extract('  const loadDraft = async', "  next.addEventListener('click'")
  ].join('\n');
  const methods = vm.runInNewContext(definitions+'\n({call,saveDraft,uploadFile,loadDraft})', context);
  await assert.rejects(methods.call('submit'), /Preview only/);
  await assert.rejects(methods.uploadFile({}, {}), /Preview only/);
  assert.equal((await methods.saveDraft()).preview, true);
  assert.equal(await methods.loadDraft(), false);
  assert.equal(effects, 0);
});
test('preview overrides draft and mobile-upload tokens without changing ordinary application flow', () => {
  const setup = extract('  const readOnlyPreview =', '  const localPreview =');
  for (const search of ['?preview=1', '?preview=1&resume=private&uploadToken=private&mobileVideo=1']) {
    const state = vm.runInNewContext(setup+'\n({state,mobileVideoMode})', {URLSearchParams,location:{search,hash:'#resume=private'}});
    assert.equal(state.state.resumeToken,null);
    assert.equal(state.state.mobileUploadToken,null);
    assert.equal(state.mobileVideoMode,false);
  }
  const normal = vm.runInNewContext(setup+'\n({state,mobileVideoMode})', {URLSearchParams,location:{search:'?resume=private',hash:''}});
  assert.equal(normal.state.resumeToken,'private');
});
test('preview Continue bypasses validation and Submit cannot dispatch; all four steps are accessible', async () => {
  const handlers = {};
  const context = {readOnlyPreview:true, steps:Array(4), state:{step:1}, previewNotice:'Preview',
    next:{addEventListener:(_,fn)=>{handlers.next=fn;}}, previous:{addEventListener:()=>{}},
    save:{addEventListener:()=>{}}, form:{addEventListener:(_,fn)=>{handlers.submit=fn;}},
    showStep:n=>{context.state.step=n;}, message:()=>{}};
  vm.runInNewContext(extract("  next.addEventListener('click'",'  fileInputs.forEach(input => input.addEventListener'),context);
  for(let step=2;step<=4;step++){await handlers.next();assert.equal(context.state.step,step);}
  let prevented=false;
  await handlers.submit({preventDefault:()=>{prevented=true;}});
  assert.equal(prevented,true);
  assert.match(source,/const reviewMode = localPreview \|\| readOnlyPreview/);
  for (const helper of ['clearPhoneUploadWatch','savePhoneUploadWatch','restorePhoneUploadWatch','startPhoneUploadPolling']) {
    assert.match(source,new RegExp('function '+helper+'\\([^)]*\\) \\{\\s*if \\(readOnlyPreview\\) return'));
  }
});
