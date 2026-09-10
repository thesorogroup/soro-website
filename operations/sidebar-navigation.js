(function(root,factory){const api=factory(root);if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.SoroSidebarNavigation=api;}(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const GROUPS=[
    {id:'clients',label:'Client Management',views:['clients','client-shortlists','placements']},
    {id:'talent',label:'Talent',views:['vas','available-talent','talent-review','work-log']},
    {id:'operations',label:'Operations',views:['documents','reports']},
    {id:'administration',label:'Administration',views:['employees','payroll','talent-payout-review']}
  ];
  let nav,scroll,footer,observer,lastScope='',lastView='',scheduled=false;
  function refreshBadges(){
    if(!nav)return;
    for(const group of nav.querySelectorAll('[data-nav-group]')){
      const count=[...group.querySelectorAll('.nav-link:not([hidden]) b:not([hidden])')].reduce((sum,b)=>sum+(Number(b.textContent)||0),0);
      const badge=group.querySelector('[data-group-count]');
      if(badge.textContent!==String(count))badge.textContent=String(count);
      badge.hidden=!count||group.open;
      badge.setAttribute('aria-label',`${count} items needing attention`);
    }
  }
  function initialize(){
    if(nav||!root.document)return;
    nav=root.document.getElementById('main-nav');if(!nav)return;
    scroll=root.document.createElement('div');scroll.className='sidebar-nav-scroll';
    const primary=root.document.createElement('div');primary.className='sidebar-nav-primary';
    footer=root.document.createElement('div');footer.className='sidebar-nav-footer';footer.id='sidebar-nav-footer';
    const buttons=[...nav.querySelectorAll('.nav-link')];
    const grouped=new Set(GROUPS.flatMap(g=>g.views));
    buttons.filter(b=>!grouped.has(b.dataset.view)&&!['my-profile','feedback','help'].includes(b.dataset.view)&&b.id!=='founder-account-nav').forEach(b=>primary.append(b));
    scroll.append(primary);
    GROUPS.forEach(config=>{
      const section=root.document.createElement('details');section.className='sidebar-nav-group';section.dataset.navGroup=config.id;
      section.innerHTML=`<summary><span>${config.label}</span><b data-group-count hidden>0</b><span class="nav-group-chevron" aria-hidden="true">›</span></summary><div class="sidebar-nav-group-items"></div>`;
      const items=section.querySelector('.sidebar-nav-group-items');config.views.forEach(view=>{const b=buttons.find(b=>b.dataset.view===view);if(b)items.append(b);});
      section.addEventListener('toggle',()=>{refreshBadges();if(lastScope)try{root.localStorage.setItem(`soro-nav:${lastScope}:${config.id}`,String(section.open));}catch{}});
      scroll.append(section);
    });
    const support=buttons.find(b=>b.dataset.view==='help');if(support)scroll.append(support);
    buttons.filter(b=>b.dataset.view==='my-profile'||b.id==='founder-account-nav').forEach(b=>footer.append(b));
    const feedback=buttons.find(b=>b.dataset.view==='feedback');if(feedback)footer.append(feedback);
    nav.append(scroll,footer);nav.classList.add('is-organized');
    observer=new root.MutationObserver(records=>{
      if(!records.some(r=>!(r.target.nodeType===1?r.target:r.target.parentElement)?.closest('summary')))return;
      if(!scheduled){scheduled=true;queueMicrotask(()=>{scheduled=false;refreshBadges();});}
    });
    observer.observe(scroll,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden']});
  }
  function sync({role='',userId='',view=''}={}){
    initialize();if(!nav)return;
    const scope=`${userId}:${role}`,scopeChanged=scope!==lastScope,viewChanged=view!==lastView;
    const simple=['client_admin','client_reviewer','client_billing','virtual_assistant'].includes(role);
    nav.classList.toggle('is-simple',simple);
    for(const group of nav.querySelectorAll('[data-nav-group]')){
      const links=[...group.querySelectorAll('.nav-link')],visible=links.some(b=>!b.hidden);
      group.hidden=!visible;
      if(scopeChanged){let saved=null;try{saved=root.localStorage.getItem(`soro-nav:${scope}:${group.dataset.navGroup}`);}catch{}group.open=simple||saved==='true';}
      if(simple||((viewChanged||scopeChanged)&&links.some(b=>!b.hidden&&b.classList.contains('active'))))group.open=true;
    }
    lastScope=scope;lastView=view;refreshBadges();
  }
  return {GROUPS,sync,refreshBadges};
}));
