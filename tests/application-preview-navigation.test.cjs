const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const read=path=>fs.readFileSync(path,'utf8');
test('application preview is a separate current-live link, grouped immediately above Work Log',()=>{
  const html=read('operations/index.html'),link=html.match(/<a[^>]+id="application-preview-nav"[^>]*>/)?.[0];
  assert.ok(link);assert.match(link,/href="https:\/\/thesorogroup.com\/application\/\?preview=1"/);
  assert.match(link,/target="_blank"/);assert.match(link,/rel="noopener noreferrer"/);assert.match(link,/hidden/);assert.doesNotMatch(link,/data-view/);
  const nav=read('operations/sidebar-navigation.js');
  assert.match(nav,/config.id==='talent'/);assert.match(nav,/items.insertBefore\(preview,items.querySelector\('\[data-view="work-log"\]'\)\)/);
});
test('application preview link follows active Admin and Talent Management workspace visibility',()=>{
  const source=read('operations/operations.js'),start=source.indexOf("  const applicationPreview=document.getElementById('application-preview-nav');"),end=source.indexOf('  const supportNav=',start),guard=source.slice(start,end);
  const visible=(access,accessRole=access?.role,sample=false,currentAccess)=>{const el={hidden:true};vm.runInNewContext(guard,{document:{getElementById:()=>el},window:{SoroTestSession:sample?{}:undefined,soroCurrentAccess:currentAccess},access,accessRole});return!el.hidden;};
  for(const role of ['admin','talent_management','sales','sales_management','client_admin','virtual_assistant','billing']){
    const access={user_id:'sample',role,active:true,must_change_password:false};
    assert.equal(visible(access),['admin','talent_management'].includes(role));
    assert.equal(visible({...access,active:false}),false);assert.equal(visible({...access,must_change_password:true}),false);
    assert.equal(visible(access,role,true),false);
  }
  assert.equal(visible(null),false);
  assert.equal(visible({user_id:'founder',role:'admin',is_founder:true,active:true},'talent_management'),true);
  assert.equal(visible({user_id:'founder',role:'admin',is_founder:true,active:true},'client_admin'),false);
  const verified={user_id:'founder',role:'admin',is_founder:true,active:true},authRow={role:'admin',is_founder:true,active:true};
  assert.equal(visible(authRow,'admin',false,verified),true,'auth rows omit the session user ID');
  assert.equal(visible(authRow,'talent_management',false,verified),true);
  assert.equal(visible(authRow,'admin'),false,'no verified identity must remain hidden');
  assert.equal(visible(null,'admin',false,verified),false,'signed-out event must remain hidden');
  assert.equal(visible({...authRow,active:false},'admin',false,verified),false);
  assert.equal(visible({...authRow,must_change_password:true},'admin',false,verified),false);
  assert.equal(visible(authRow,'client_admin',false,verified),false);
  assert.equal(visible(authRow,'admin',true,verified),false);
});
test('Founder Test Mode exposes the preview in the parent without loosening its sandbox',()=>{
  const source=read('operations/founder-test-mode.js');
  assert.match(source,/previewLink.href='https:\/\/thesorogroup.com\/application\/\?preview=1'/);
  assert.match(source,/querySelector\('\.founder-test-bar'\).insertBefore\(previewLink/);
  assert.match(source,/setAttribute\('sandbox','allow-scripts allow-forms'\)/);
  assert.doesNotMatch(source,/allow-popups|allow-same-origin|allow-top-navigation/);
});
