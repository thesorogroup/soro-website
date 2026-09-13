/* Opaque, credential-free rendering context. All reads go through the Founder gateway. */
(function(w){
 'use strict';if(w.parent===w)return;
 let subject=null,sequence=0;const pending=new Map();
 const notice=message=>w.parent.postMessage({type:'soro-live-notice',message},'*');
 const denied=()=>new Error('Read-Only Live View — make changes from your Admin Panel.');
 function read(resource,params={}){
  return new Promise((resolve,reject)=>{const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error('The live view took too long to load. Try selecting the account again.'));},30000);pending.set(id,{resolve,reject,timer});w.parent.postMessage({type:'soro-live-read',id,resource,params},'*');});
 }
 w.addEventListener('message',e=>{if(e.source!==w.parent||e.data?.type!=='soro-live-result')return;const p=pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);pending.delete(e.data.id);e.data.error?p.reject(new Error(e.data.error)):p.resolve(e.data.data);});
 function query(table){
  const resources={applicants:'profile',documents:'profile-documents',placements:'profile-placements',talent_attendance_sessions:'profile-attendance'};
  const filters=[];let single=false,write=false;
  const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},is(k,v){filters.push(r=>(r[k]??null)===v);return q},neq(k,v){filters.push(r=>r[k]!==v);return q},not(){return q},order(){return q},limit(){return q},range(){return q},maybeSingle(){single=true;return q},single(){single=true;return q},update(){write=true;return q},insert(){write=true;return q},delete(){write=true;return q},then(resolve,reject){
   const result=write||(!resources[table]&&table!=='platform_users')?Promise.reject(denied()):(table==='platform_users'?Promise.resolve(subject):read(resources[table])).then(value=>{const items=(Array.isArray(value)?value:value?[value]:[]).filter(r=>filters.every(f=>f(r)));return{data:single?(items[0]||null):items,error:null};});
   return result.catch(e=>({data:null,error:{message:e.message}})).then(resolve,reject);
  }};return q;
 }
 w.soroCurrentAccess=null;
 w.soroSupabase={auth:{getSession:async()=>({data:{session:subject?{access_token:'observer-not-a-credential',user:{id:subject.user_id,email:subject.email||''}}:null}}),getUser:async()=>({data:{user:subject?{id:subject.user_id}:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:query,rpc:async()=>({data:null,error:{message:denied().message}}),storage:{from:bucket=>({createSignedUrl:async path=>{try{if(bucket!=='soro-private-documents')throw denied();return{data:await read('profile-file',{path}),error:null}}catch(e){return{data:null,error:{message:e.message}}}},upload:async()=>({error:{message:denied().message}})})}};
 w.fetch=async function(url,options={}){
  const u=new URL(typeof url==='string'?url:url.url,'https://observer.invalid');
  let resource=u.pathname.split('/').pop(),params=Object.fromEntries(u.searchParams),method=String(options.method||'GET').toUpperCase();
  if(u.origin!=='https://observer.invalid'||!u.pathname.startsWith('/.netlify/functions/'))return new Response(JSON.stringify({message:denied().message}),{status:403});
  if(method==='POST'){
   let body;try{body=JSON.parse(options.body||'{}');}catch{body={};}
   if(resource==='task-detail'&&['workspace','get','view'].includes(body.action)){resource=body.action==='workspace'?'tasks':'task-detail';params=body.action==='workspace'?{}:{taskId:body.taskId};}
   else if(resource==='talent-healthcare'&&body.action==='view')params={applicantId:body.applicantId};
   else {notice(denied().message);return new Response(JSON.stringify({message:denied().message}),{status:403});}
  }else if(method!=='GET'){return new Response(JSON.stringify({message:denied().message}),{status:403});}
  try{return new Response(JSON.stringify(await read(resource,params)),{status:200,headers:{'Content-Type':'application/json'}});}
  catch(e){return new Response(JSON.stringify({message:e.message}),{status:403,headers:{'Content-Type':'application/json'}});}
 };
 w.XMLHttpRequest=w.WebSocket=w.EventSource=w.Worker=function(){throw denied();};
 // No external navigation or form submission can escape the read-only sandbox.
 w.open=()=>{notice('Open files and meeting links from your Admin Panel. This view does not act as the selected account.');return null;};
 const isFilter=form=>form?.matches('.dc-filters,.wl-filters,.ah-filters,[data-support-filters]');
 document.addEventListener('submit',e=>{if(isFilter(e.target))return;e.preventDefault();e.stopImmediatePropagation();notice(denied().message);},true);
 document.addEventListener('click',e=>{const link=e.target.closest('a[href]');if(!link)return;e.preventDefault();e.stopImmediatePropagation();const href=link.getAttribute('href');if(href.startsWith('#'))w.dispatchEvent(new CustomEvent('soro-live-route',{detail:href.slice(1)}));else notice('External links can be opened from your Admin Panel.');},true);
 for(const key of ['localStorage','sessionStorage']){const data=new Map();try{Object.defineProperty(w,key,{value:{getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),clear:()=>data.clear()}})}catch{}}
 const nativeReplace=w.history.replaceState.bind(w.history);for(const method of ['replaceState','pushState'])w.history[method]=(state,title,url)=>{const hash=String(url||'').includes('#')?'#'+String(url).split('#').slice(1).join('#'):'';nativeReplace(state,title,'about:srcdoc'+hash);};
 w.SoroLiveObserver={read,notice,isFilter,init(value){subject=Object.freeze({...value});w.soroCurrentAccess=subject;}};
}(window));
