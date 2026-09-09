/* Saved Loom links are an explicit, click-to-load fallback, not private copies. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.SoroLoomIntroduction=api;})(typeof window!=='undefined'?window:globalThis,function(){
 'use strict';
 function canonical(value){
  const candidates=String(value||'').match(/https?:\/\/[^\s<>"']+/gi)||[];
  if(candidates.length!==1)return null;
  try{
   const url=new URL(candidates[0]);
   if(url.protocol!=='https:'||!['loom.com','www.loom.com'].includes(url.hostname)||url.username||url.password||url.port)return null;
   const match=url.pathname.match(/^\/(?:share|embed)\/([a-f0-9]{32})\/?$/i);
   if(!match)return null;
   const id=match[1].toLowerCase();
   return {id,share:'https://www.loom.com/share/'+id,embed:'https://www.loom.com/embed/'+id};
  }catch{return null;}
 }
 function source(applicant,documents=[]){
  const rejected=new Set(documents.filter(d=>d.document_type==='introduction_video'&&d.status==='rejected').map(d=>canonical(d.external_url)?.id).filter(Boolean));
  const values=[applicant?.loom_video_url,...documents.filter(d=>d.document_type==='introduction_video'&&d.status!=='rejected'&&!d.storage_path).map(d=>d.external_url)];
  return values.map(canonical).find(info=>info&&!rejected.has(info.id))||null;
 }
 function canView(access,applicant){
  return !!access?.user_id&&!!applicant?.id&&!!access.organization_id&&access.organization_id===applicant.organization_id
   && (['admin','talent_management'].includes(access.role)||(access.role==='virtual_assistant'&&applicant.auth_user_id===access.user_id));
 }
 function markup(info){
  // URLs contain only a validated, reconstructed 32-character recording ID.
  if(!info||!canonical(info.share))return '';
  const safe=canonical(info.share);
  return '<section class="profile-introduction-video profile-loom-video"><div><p class="eyebrow">Introduction video</p><strong>Applicant’s Loom recording</strong></div><div class="profile-loom-player" data-loom-player><button type="button" class="profile-loom-play" data-play-loom="'+safe.id+'"><span aria-hidden="true">▶</span><span>Play introduction</span></button></div><small>Loom-hosted · loads only when you press play</small><a class="profile-loom-open" href="'+safe.share+'" target="_blank" rel="noopener noreferrer">Open in Loom ↗</a></section>';
 }
 function bind(target,stillCurrent){
  target.querySelectorAll('[data-play-loom]').forEach(button=>button.addEventListener('click',()=>{
   if(!stillCurrent())return;
   const info=canonical('https://www.loom.com/share/'+button.dataset.playLoom);
   const holder=button.closest('[data-loom-player]');
   if(!info||!holder)return;
   const frame=target.ownerDocument.createElement('iframe');
   frame.src=info.embed;frame.title='Introduction video hosted on Loom';
   frame.setAttribute('allow','fullscreen; picture-in-picture');frame.setAttribute('allowfullscreen','');
   frame.setAttribute('referrerpolicy','no-referrer');
   frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-presentation');
   holder.replaceChildren(frame);
  }));
 }
 return {canonical,source,canView,markup,bind};
});
