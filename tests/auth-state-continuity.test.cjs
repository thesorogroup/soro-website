'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../operations/auth.js'),'utf8');
const userId='10000000-0000-4000-8000-000000000010',orgId='10000000-0000-4000-8000-000000000001';
function harness(){
 const elements=new Map(),timers=[],events=[],listeners=new Map();let callback,reads=0,renders=0,signouts=0,queryError=null,holdNext=null;
 let access={role:'admin',organization_id:orgId,active:true,must_change_password:false,display_name:'Example Admin',is_founder:true,initial_password_issued_at:null,password_changed_at:null};
 const session={user:{id:userId,email:'example@example.test',user_metadata:{}},access_token:'synthetic-only'};
 function element(id){return {id,hidden:id!=='auth-checking',textContent:'',className:'',dataset:{},classList:{toggle(){}},elements:{currentPassword:{focus(){}},newPassword:{focus(){}}},addEventListener(){},querySelector(){return null;},querySelectorAll(){return [];},closest(){return null;},setAttribute(){},reset(){},focus(){}};}
 const get=id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);};
 const document={getElementById:get,body:{className:''},createTextNode:text=>({textContent:text}),title:'Auth fixture'};
 const window={document,location:new URL('https://thesorogroup.com/operations/#talent/example'),history:{replaceState(){}},setTimeout:(fn,delay)=>timers.push({fn,delay}),SORO_SUPABASE_CONFIG:{url:'https://auth-test.supabase.co',publishableKey:'synthetic-only'},addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:event=>{events.push(event);listeners.get(event.type)?.(event);}};
 const client={from:()=>({select(){return this;},eq(){return this;},maybeSingle:async()=>{reads++;const result={data:access?{...access}:null,error:queryError};if(holdNext){const pending=holdNext;holdNext=null;await pending;}return result;}}),auth:{onAuthStateChange:fn=>{callback=fn;},getSession:async()=>({data:{session}}),signOut:async()=>{signouts++;callback('SIGNED_OUT',null);return {error:null};}}};
 window.supabase={createClient:()=>client};
 const context={window,document,URL,URLSearchParams,Date,Set,Object,setTimeout:window.setTimeout,CustomEvent:class{constructor(type,init){this.type=type;this.detail=init.detail;}},role:'admin',roleConfig:{admin:{className:'role-admin'},talent:{className:'role-talent'}},render:()=>{renders++;get('view-root').content={render:renders};},setActive(){}};
 vm.runInNewContext(source,context);
 const flush=async()=>{for(let i=0;i<15;i++){await Promise.resolve();const pending=timers.splice(0);for(const timer of pending)if(!timer.delay)await timer.fn();}};
 return {context,window,get,events,session,flush,emit:async(event,s=session)=>{callback(event,s);await flush();},change:delta=>{access={...access,...delta};},error:()=>{queryError=Error('Unavailable');},deferNext:()=>{let release;holdNext=new Promise(r=>release=r);return release;},get reads(){return reads;},get renders(){return renders;},get signouts(){return signouts;}};
}

test('same-user sign-in confirmation and token refresh revalidate without replacing the active profile or resetting the Admin preview',async()=>{
 const h=harness();await h.flush();assert.equal(h.reads,1);assert.equal(h.renders,1);assert.equal(h.events.length,1);
 const player=h.get('view-root').content;player.playing=true;player.pendingUpload='reserved-upload';h.context.role='talent';
 for(const event of ['SIGNED_IN','TOKEN_REFRESHED','INITIAL_SESSION'])await h.emit(event,{...h.session,access_token:'new-synthetic-only'});
 assert.equal(h.reads,4,'Every confirmation must still re-read platform access');
 assert.equal(h.renders,1);assert.equal(h.events.length,1,'Unchanged confirmation must not dispatch the teardown event');
 assert.equal(h.get('view-root').content,player);assert.equal(player.playing,true);assert.equal(player.pendingUpload,'reserved-upload');assert.equal(h.context.role,'talent');
 assert.equal(h.get('app').hidden,false);assert.equal(h.get('auth-checking').hidden,true);
});

for(const delta of [{role:'talent_management'},{organization_id:'10000000-0000-4000-8000-000000000002'},{display_name:'Changed Name'},{is_founder:false},{password_changed_at:'2026-09-08T01:00:00Z'},{initial_password_issued_at:'2026-09-08T00:00:00Z'}])test('changed access '+Object.keys(delta)[0]+' still rebuilds and notifies dependent private modules',async()=>{
 const h=harness();await h.flush();const old=h.get('view-root').content;h.change(delta);await h.emit('SIGNED_IN');
 assert.equal(h.reads,2);assert.equal(h.renders,2);assert.equal(h.events.length,2);assert.notEqual(h.get('view-root').content,old);assert.equal(h.get('app').hidden,false);
});

test('a changed authenticated user can never reuse the old private view',async()=>{
 const h=harness();await h.flush();await h.emit('SIGNED_IN',{...h.session,user:{...h.session.user,id:'10000000-0000-4000-8000-000000000011'}});
 assert.equal(h.renders,2);assert.equal(h.events.length,2);assert.equal(h.window.soroCurrentAccess.user_id,'10000000-0000-4000-8000-000000000011');
});

for(const change of ['inactive','unauthorized','query-error'])test(change+' on refresh remains fail-closed',async()=>{
 const h=harness();await h.flush();if(change==='inactive')h.change({active:false});else if(change==='unauthorized')h.change({role:'unsupported'});else h.error();
 await h.emit('TOKEN_REFRESHED');assert.equal(h.get('app').hidden,true);assert.equal(h.window.soroCurrentAccess,null);assert.equal(h.signouts,1);assert.equal(h.get('auth-gate').hidden,false);
 assert.ok(h.events.some(e=>e.detail.session===null));
});

test('a newly required password change cannot reuse the authorized workspace',async()=>{
 const h=harness();await h.flush();h.change({must_change_password:true,initial_password_issued_at:new Date().toISOString()});await h.emit('SIGNED_IN');
 assert.equal(h.get('app').hidden,true);assert.equal(h.get('first-password-gate').hidden,false);assert.equal(h.get('auth-gate').hidden,true);assert.equal(h.window.soroCurrentAccess.must_change_password,true);
});

test('sign-out still hides the app and signals teardown rather than preserving the player',async()=>{
 const h=harness();await h.flush();await h.emit('SIGNED_OUT',null);assert.equal(h.window.soroCurrentAccess,null);assert.equal(h.get('app').hidden,true);assert.equal(h.events.at(-1).detail.session,null);
});

test('a normal access read finishing after password recovery cannot reveal the cached private app',async()=>{
 const h=harness();await h.flush();const release=h.deferNext();await h.emit('SIGNED_IN');
 await h.emit('PASSWORD_RECOVERY');assert.equal(h.get('password-recovery-gate').hidden,false);assert.equal(h.get('app').hidden,true);
 release();await h.flush();
 assert.equal(h.get('password-recovery-gate').hidden,false);assert.equal(h.get('app').hidden,true);assert.equal(h.window.soroCurrentAccess,null);assert.equal(h.renders,1);
 await h.emit('TOKEN_REFRESHED');assert.equal(h.get('password-recovery-gate').hidden,false);assert.equal(h.get('app').hidden,true);
});
