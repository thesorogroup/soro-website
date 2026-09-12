(function(w){
  'use strict';
  const session=w.SoroTestSession;
  if(!session||w.parent===w)return;
  // Keep the real Client workflow screens and permissions, replacing only their data adapter.
  const originalClientOptions=clientWorkflowMountOptions;
  clientWorkflowMountOptions=function(accessRole){
    const options=originalClientOptions(accessRole);
    const seed=session.store.clients;
    const adapter=w.SoroClientWorkflow.createApprovalAdapter(seed);
    options.adapter=Object.fromEntries(Object.entries(adapter).map(([key,method])=>[key,typeof method!=='function'?method:async(...args)=>{
      const write=!['listOwners','listClients','loadWorkspace','loadClient'].includes(key);
      if(write&&session.selected!=='sales')throw new Error('This portal can view Client records but cannot edit them.');
      if(['changePortalAccess','resendPortalInvite'].includes(key))throw new Error('Invitations and account access changes are disabled in Test Mode.');
      const result=await method(...args);if(write){session.store.clients=await adapter.listClients();const c=session.store.clients.find(c=>c.id===session.id(50));if(c){session.store.companyName=c.company.name;session.store.contactName=c.primaryContact.name;}session.notice('Sample Client updated. No live record or invitation was created.');}return result;
    }]));
    return options;
  };
  const placement=w.SoroClientPlacementWorkflow;
  w.SoroClientPlacementWorkflow={...placement,mount(host,options){
    const data=placement.defaultSeed(options.role),id=session.id;
    data.generatedAt=new Date().toISOString();data.request={...data.request,hiringRequestId:options.hiringRequestId,clientId:id(50),companyName:session.store.companyName,title:'General Virtual Assistant',status:'filled',seats:1,filledSeats:1,updatedAt:data.generatedAt};
    data.calendarIntegration={configured:false,organizerLabel:'Disabled in Test Mode'};data.candidates=[];data.handoffs=[];
    data.placements=[{placementId:id(21),applicantId:id(10),fullName:'Jamie Cruz',status:'active',startDate:data.generatedAt.slice(0,10),scheduleSummary:'Monday–Friday · Philippine Time',updatedAt:data.generatedAt,onboardingItems:[]}];
    return placement.mount(host,{...options,adapter:{kind:'approval',loadWorkflow:async()=>data,mutate:async()=>{throw new Error('Placement changes are not available in this test session.');}}});
  }};
  function select(value,reset=false){
    if(!session.personas[value])return;
    if(reset)session.reset();session.select(value);
    w.soroCurrentAccess=session.access();
    role=value;current='overview';selectedTalentId=null;selectedClientId=null;preferredHiringRequestId='';preferredClientTalentId='';
    w.soroTaskDetail?.close();document.querySelectorAll('dialog[open]').forEach(d=>d.close());history.replaceState({},'','#overview');
    liveApplicants=[];ownTalentProfile=null;ownTalentProfileState='idle';
    document.body.className=roleConfig[role].className;
    document.getElementById('auth-checking').hidden=true;document.getElementById('auth-gate').hidden=true;document.getElementById('app').hidden=false;
    const identity=document.getElementById('role-switcher');identity.querySelector('strong').textContent=session.personas[value].name;identity.querySelector('small').textContent=roleConfig[value].label+' · Sample';identity.querySelector('.avatar').textContent=session.personas[value].name.split(' ').map(s=>s[0]).join('');identity.disabled=true;
    // srcdoc keeps an opaque origin: routing is fragment-only and never uses the live URL.
    w.soroSyncAuthorizedNavigation?.(w.soroCurrentAccess);setActive();render();
    w.dispatchEvent(new CustomEvent('soro-auth-changed',{detail:{session:{user:{id:w.soroCurrentAccess.user_id}},access:w.soroCurrentAccess}}));
    session.notice('Test Mode · '+roleConfig[value].label+' · All records are fictional.');
  }
  document.getElementById('sign-out').hidden=true;
  w.addEventListener('message',event=>{if(event.source!==w.parent||event.data?.type!=='soro-test-control')return;const {command,value}=event.data;if(command==='role'||command==='reset')select(value,command==='reset');});
  select('client');
  w.parent.postMessage({type:'soro-test-ready'},'*');
}(window));
