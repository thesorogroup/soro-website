'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const D=require('../operations/report-definitions.js'),source=fs.readFileSync(require.resolve('../operations/reports.js'),'utf8');
const id=n=>'10000000-0000-4000-8000-'+String(n).padStart(12,'0'),flush=()=>new Promise(r=>setImmediate(r));
function fixture(session=id(1)){
 const listeners={},events={},content={innerHTML:'',addEventListener:(event,fn)=>listeners[event]=fn};
 let html='';const host={get innerHTML(){return html;},set innerHTML(v){html=v;},querySelector:()=>content,contains:x=>x===content&&html.includes('data-reports-content'),replaceChildren(){html='';}};
 let respond=async()=>({ok:true,json:async()=>({report:'talent',role:'admin',generatedAt:'2026-09-09T00:00:00Z',total:0,offset:0,rows:[],summary:{total:0,statuses:{},flags:{}},options:{}})});const calls=[];
 const context=vm.createContext({SoroReportDefinitions:D,AbortController,URLSearchParams,FormData,console,
  soroCurrentAccess:{user_id:id(1),organization_id:id(2),role:'admin',active:true,must_change_password:false},
  soroSupabase:{auth:{getSession:async()=>({data:{session:{access_token:'sample-token',user:{id:session}}}})}},
  fetch:async(...args)=>{calls.push(args);return respond(...args);},addEventListener:(name,fn)=>events[name]=fn});
 vm.runInContext(source,context);
 const click=(attr,value)=>listeners.click({target:{closest:()=>({dataset:attr==='data-report'?{report:value}:{},hasAttribute:k=>k===attr})}});
 return{api:context.SoroReports,context,host,content,events,calls,click,respond:fn=>respond=fn};
}
test('Reports never use a different account session',async()=>{const f=fixture(id(9));f.api.mount(f.host);f.click('data-report','talent');await flush();assert.equal(f.calls.length,0);assert.match(f.content.innerHTML,/Sign in again/);f.api.unmount();});
test('Admin role preview shows layouts without querying private data',async()=>{const f=fixture();f.api.mount(f.host,{role:'sales',preview:true});f.click('data-report','sales');await flush();assert.equal(f.calls.length,0);assert.match(f.content.innerHTML,/Workspace preview/);f.api.unmount();});
test('Late reports cannot overwrite another page or switched account',async()=>{const f=fixture();let finish;f.respond(()=>new Promise(r=>finish=r));f.api.mount(f.host);f.click('data-report','talent');await flush();f.host.innerHTML='<h1>Tasks</h1>';finish({ok:true,json:async()=>({report:'talent',role:'admin',rows:[{title:'PRIVATE'}]})});await flush();assert.equal(f.host.innerHTML,'<h1>Tasks</h1>');assert.doesNotMatch(f.content.innerHTML,/PRIVATE/);f.events['soro-auth-changed']();assert.equal(f.host.innerHTML,'');});
test('Changing report cancels relevance of a previous slower report result',async()=>{const f=fixture();let finish;f.respond(()=>new Promise(r=>finish=r));f.api.mount(f.host);f.click('data-report','talent');await flush();f.click('data-library');finish({ok:true,json:async()=>({report:'talent',role:'admin',rows:[{title:'PRIVATE'}]})});await flush();assert.match(f.content.innerHTML,/Report library/);assert.doesNotMatch(f.content.innerHTML,/PRIVATE/);f.api.unmount();});
