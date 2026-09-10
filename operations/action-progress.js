/* Branded progress feedback. Never retries, cancels, or changes a request. */
(function(root,factory){
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root?.document){root.SoroActionProgress=api;api.install();}
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  function createTracker({setTimer=setTimeout,clearTimer=clearTimeout,notify=()=>{}}={}){
    const pending=new Map();let sequence=0;
    function publish(){
      const items=[...pending.values()].filter(item=>item.visible).sort((a,b)=>b.priority-a.priority||a.id-b.id);
      const first=items[0];
      try{notify(first?{label:first.label,long:first.long,count:pending.size}:null);}catch{/* Cosmetic feedback cannot interfere with work. */}
    }
    function begin({label='Working on your request…',immediate=false,priority=0}={}){
      const id=++sequence,item={id,label:String(label).slice(0,120),priority,visible:immediate,long:false};
      pending.set(id,item);
      if(!immediate)item.delay=setTimer(()=>{if(pending.has(id)){item.visible=true;publish();}},350);
      item.slow=setTimer(()=>{if(pending.has(id)){item.long=true;publish();}},10000);
      publish();
      let done=false;
      return ()=>{if(done)return;done=true;clearTimer(item.delay);clearTimer(item.slow);pending.delete(id);publish();};
    }
    function clear(){for(const item of pending.values()){clearTimer(item.delay);clearTimer(item.slow);}pending.clear();publish();}
    return {begin,clear};
  }
  function shouldTrack(input,options={},locationHref,storageOrigin){
    try{
      const method=String(options?.method||input?.method||'GET').toUpperCase();
      if(!['POST','PUT','PATCH','DELETE'].includes(method))return false;
      const base=new URL(locationHref),url=new URL(typeof input==='string'?input:input?.url||String(input),base);
      if(url.origin===base.origin&&url.pathname.startsWith('/.netlify/functions/'))return true;
      return !!storageOrigin&&url.origin===new URL(storageOrigin).origin&&(/^\/rest\/v1\//.test(url.pathname)||/^\/storage\/v1\/object\//.test(url.pathname));
    }catch{return false;}
  }
  function wrapFetch(fetcher,tracker,context){
    return function(input,options){
      let finish;
      try{if(shouldTrack(input,options,context.href(),context.storage()))finish=tracker.begin();}catch{/* Feedback must never prevent the real request. */}
      try{return Promise.resolve(fetcher.apply(this,arguments)).finally(()=>finish?.());}
      catch(error){finish?.();throw error;}
    };
  }
  let panel,labelNode,noteNode,installed=false,lastAnnouncement='';
  function display(state){
    const document=root?.document;if(!document?.body)return;
    if(!panel){
      panel=document.createElement('aside');panel.className='soro-action-progress';panel.hidden=true;
      panel.setAttribute('popover','manual');panel.setAttribute('role','status');panel.setAttribute('aria-live','polite');panel.setAttribute('aria-atomic','true');
      const mark=document.createElement('span');mark.className='soro-action-progress__mark';mark.setAttribute('aria-hidden','true');
      const image=document.createElement('img');image.src='/assets/soro-ops-fox-command-icon.png';image.alt='';image.width=44;image.height=44;mark.append(image);
      const copy=document.createElement('span');copy.className='soro-action-progress__copy';
      labelNode=document.createElement('strong');noteNode=document.createElement('span');copy.append(labelNode,noteNode);panel.append(mark,copy);document.body.append(panel);
    }
    if(!state){
      if(!panel.hidden){try{panel.hidePopover?.();}catch{}panel.hidden=true;}
      lastAnnouncement='';return;
    }
    // Keep the live region inside a modal's accessible subtree as well as above its visual top layer.
    const dialogs=[...(document.querySelectorAll('dialog[open]')||[])];
    const parent=dialogs.at(-1)||document.body;
    if(panel.parentNode!==parent){try{panel.hidePopover?.();}catch{}panel.hidden=true;parent.append(panel);}
    const note=state.long?'Still working. Please wait before trying again.':'Please wait a moment.';
    const announcement=state.label+'|'+note;
    if(lastAnnouncement!==announcement){labelNode.textContent=state.label;noteNode.textContent=note;lastAnnouncement=announcement;}
    if(panel.hidden){
      panel.hidden=false;
      try{if(typeof panel.showPopover==='function')panel.showPopover();
        else{panel.removeAttribute('popover');(document.querySelector('dialog[open]')||document.body).append(panel);}}
      catch{panel.removeAttribute('popover');(document.querySelector('dialog[open]')||document.body).append(panel);}
    }
  }
  const tracker=createTracker({notify:display});
  function begin(label,options={}){return tracker.begin({immediate:true,...options,label,priority:10});}
  function install(){
    if(installed||typeof root?.fetch!=='function')return;installed=true;
    root.fetch=wrapFetch(root.fetch,tracker,{href:()=>root.location.href,storage:()=>root.SORO_SUPABASE_CONFIG?.url});
    root.addEventListener('pagehide',()=>tracker.clear());
  }
  return {begin,install,_test:{createTracker,shouldTrack,wrapFetch}};
});
