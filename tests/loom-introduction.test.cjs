'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const api=require('../operations/loom-introduction.js');
const id='87631fa7dfbe4b9cadc78c534e3b6079',url='https://www.loom.com/share/'+id;
test('canonicalizes a saved Loom share or embed link without sending tracking or applicant data',()=>{
 assert.deepEqual(api.canonical(url+'?sid=tracking#fragment'),{id,share:url,embed:'https://www.loom.com/embed/'+id});
 assert.equal(api.canonical('.... '+url).id,id);
 assert.equal(api.canonical('https://loom.com/embed/'+id).id,id);
});
test('rejects malformed, misleading, non-HTTPS and multiple Loom links without guessing a recording',()=>{
 for(const value of [url+'y',url.slice(0,-1),url+'/other',url.replace('www.loom.com','loom.com.evil.example'),url.replace('https:','http:'),url.replace('www.loom.com','user@www.loom.com'),url.replace('www.loom.com','www.loom.com:99'),url+' '+url,'javascript:alert(1)','<script>'])assert.equal(api.canonical(value),null,value);
});
test('only introduction sources qualify and uploaded/rejected documents do not become external fallback',()=>{
 assert.equal(api.source({loom_video_url:url}).id,id);
 assert.equal(api.source({},[{document_type:'resume',external_url:url}]),null);
 assert.equal(api.source({},[{document_type:'introduction_video',external_url:url,status:'rejected'}]),null);
 assert.equal(api.source({loom_video_url:url},[{document_type:'introduction_video',external_url:url+'?tracking=1',status:'rejected'}]),null);
 assert.equal(api.source({},[{document_type:'introduction_video',external_url:url,storage_path:'private.mp4'}]),null);
 assert.equal(api.source({},[{document_type:'introduction_video',external_url:url,status:'uploaded'}]).id,id);
});
test('Loom fallback respects current private profile role and ownership boundaries',()=>{
 const a={id:'a',organization_id:'o',auth_user_id:'u'};
 for(const role of ['admin','talent_management','virtual_assistant'])assert.equal(api.canView({role,user_id:'u',organization_id:'o'},a),true);
 for(const role of ['sales','sales_management','client','anonymous'])assert.equal(api.canView({role,user_id:'u',organization_id:'o'},a),false);
 assert.equal(api.canView({role:'virtual_assistant',user_id:'other',organization_id:'o'},a),false);
 assert.equal(api.canView({role:'admin',user_id:'u',organization_id:'other'},a),false);
});
test('Loom markup is click-to-load, identifies external hosting, and contains no automatic third-party request',()=>{
 const html=api.markup(api.canonical(url));
 assert.match(html,/Loom-hosted/);assert.match(html,/Play introduction/);assert.match(html,/rel="noopener noreferrer"/);
 assert.doesNotMatch(html,/<iframe|<img|src=/);assert.doesNotMatch(html,/Private Soro file/);
});
test('Loom player only loads after user action on the same profile',()=>{
 let click,frame,rendered=false,current=false;
 const holder={replaceChildren(value){frame=value;rendered=true;}};
 const button={dataset:{playLoom:id},addEventListener(_,f){click=f;},closest(){return holder;}};
 const target={querySelectorAll(){return [button];},ownerDocument:{createElement(){return {setAttribute(k,v){this[k]=v;}};}}};
 api.bind(target,()=>current);click();assert.equal(rendered,false);current=true;click();
 assert.equal(frame.src,'https://www.loom.com/embed/'+id);assert.equal(frame.referrerpolicy,'no-referrer');
 assert.equal(frame.sandbox,'allow-scripts allow-same-origin allow-presentation');
});
test('header keeps private uploads first and wires external_url projection and load guard',()=>{
 const code=fs.readFileSync(require.resolve('../operations/inline-intro-video.js'),'utf8');
 assert.match(code,/if \(!introVideo && loom\?\.canView/);assert.match(code,/external_url,created_at/);assert.match(code,/loom\?\.bind\(target, stillCurrent\)/);
 const html=fs.readFileSync(require.resolve('../operations/index.html'),'utf8');
 assert.ok(html.indexOf('loom-introduction.js?')<html.indexOf('inline-intro-video.js?'));
});
