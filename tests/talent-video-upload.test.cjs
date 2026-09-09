'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{createHash}=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const api=require('../netlify/functions/lib/talent-video-upload');
const {validate}=require('../netlify/functions/talent-profile-files');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const requestId='10000000-0000-4000-8000-000000000010';
function mp4(brand='isom'){const head=Buffer.alloc(24);head.writeUInt32BE(24);head.write('ftyp',4);head.write(brand,8);head.write(brand,16);head.write(brand,20);return Buffer.concat([head,Buffer.from('media fixture')]);}
const fixtures=[['intro.mp4','video/mp4',mp4()],['intro.mov','video/quicktime',mp4('qt  ')],['intro.webm','video/webm',Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3]),Buffer.from('DocType webm fixture')])]];

for(const [name,type,bytes]of fixtures)test(name+' is bounded, container checked, and hashed without buffering the full video',async()=>{
 assert.equal(validate({action:'prepare',requestId,kind:'introduction_video',name,type,size:api.MAX_VIDEO_BYTES}).size,api.MAX_VIDEO_BYTES);
 const verified=await api.verifyStoredVideo(new Response(bytes),bytes.length,type);
 assert.deepEqual(verified,{size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
});
test('video validation rejects oversized, spoofed, incomplete, unsupported and cross-kind uploads',async()=>{
 assert.throws(()=>validate({action:'prepare',requestId,kind:'introduction_video',name:'intro.mp4',type:'video/mp4',size:api.MAX_VIDEO_BYTES+1}));
 for(const type of ['text/html','image/jpeg','application/pdf'])assert.throws(()=>validate({action:'prepare',requestId,kind:'introduction_video',name:'intro.mp4',type,size:50}));
 for(const [bytes,type]of [[Buffer.from('<html>not a video</html>'),'video/mp4'],[mp4('qt  '),'video/mp4'],[mp4(),'video/quicktime'],[mp4(),'video/webm'],[Buffer.from([0x1a,0x45,0xdf,0xa3,0,0,0,0,0,0,0,0]),'video/webm']])await assert.rejects(()=>api.verifyStoredVideo(new Response(bytes),bytes.length,type),/format|video/);
 await assert.rejects(()=>api.verifyStoredVideo(new Response(mp4()),mp4().length-1,'video/mp4'),/large/);
 await assert.rejects(()=>api.verifyStoredVideo(new Response(mp4()),mp4().length+1,'video/mp4'),/incomplete/);
 await assert.rejects(()=>api.verifyStoredVideo(new Response(mp4(),{headers:{'content-length':'100000000'}}),mp4().length,'video/mp4'),/size/);
});
test('split stream chunks still produce an exact media digest',async()=>{
 const bytes=mp4();const body=new ReadableStream({start(c){for(let i=0;i<bytes.length;i+=3)c.enqueue(bytes.subarray(i,i+3));c.close();}});
 assert.equal((await api.verifyStoredVideo(new Response(body),bytes.length,'video/mp4')).sha256,createHash('sha256').update(bytes).digest('hex'));
});
test('migration keeps owned active Talent authorization, previous documents and service-only finalization',()=>{
 const sql=read('supabase/migrations/20260908_055_talent_self_video_uploads.sql');
 assert.doesNotMatch(sql,/delete from|update public\.documents|create policy|grant .* to authenticated/i);
 for(const pattern of [/role='virtual_assistant'/,/auth_user_id=a\.id and organization_id=a\.organization_id/,/portal_access_status='active' for share/,/uploader_id=a\.id and applicant_id=t\.id and organization_id=a\.organization_id/,/grant execute on function public\.talent_self_upload\(uuid,jsonb\) to service_role/,/byte_size between 1 and 99614720/,/kind<>'resume' or byte_size<=10485760/,/when 'video\/mp4' then 'introduction\.mp4'/,/insert into public\.documents/])assert.match(sql,pattern);
});

function headerHarness(docs,hook){
 let currentApplicant={id:'own',full_name:'Test Talent'},target={innerHTML:'',querySelectorAll:()=>[]},signed=[];
 const window={soroCurrentAccess:{user_id:'user',organization_id:'org'}};
 const query={select(){return this;},eq(){return this;},order(_key){if(_key==='id')return Promise.resolve({data:docs});return this;}};
 window.soroSupabase={from:()=>query,storage:{from:()=>({createSignedUrl:async path=>{signed.push(path);await hook?.(()=>{currentApplicant={id:'different'};});return {data:{signedUrl:'https://private.example/'+path}};}})}};
 const context={window,profilePage:()=>'',escapeHtml:s=>String(s),currentTalentProfileApplicant:()=>currentApplicant,loadTalentProfileDocuments:async()=>{},document:{getElementById:id=>id==='profile-introduction-video'?target:null,addEventListener(){}},classifyDocument:doc=>doc.document_type};
 vm.runInNewContext(read('operations/inline-intro-video.js'),context);
 return {load:()=>context.loadTalentProfileDocuments(),target,signed};
}
test('header renders the latest non-rejected private introduction and keeps company interviews separate',async()=>{
 const h=headerHarness([{id:'3',document_type:'introduction_video',status:'rejected',storage_path:'rejected.mp4'},{id:'2',document_type:'introduction_video',status:'uploaded',storage_path:'replacement.mp4',file_name:'Replacement.mp4'},{id:'1',document_type:'introduction_video',status:'uploaded',storage_path:'previous.mp4'},{id:'4',document_type:'interview_video',status:'uploaded',storage_path:'interview.mp4',file_name:'Interview.mp4'}]);
 await h.load();assert.deepEqual(h.signed,['replacement.mp4','interview.mp4']);assert.match(h.target.innerHTML,/Replacement.mp4/);assert.match(h.target.innerHTML,/Company interview/);assert.doesNotMatch(h.target.innerHTML,/rejected.mp4|previous.mp4/);
});
test('header cannot paint a signed video after changing Talent profiles',async()=>{
 const h=headerHarness([{document_type:'introduction_video',status:'uploaded',storage_path:'intro.mp4'}],change=>change());await h.load();assert.equal(h.target.innerHTML,'');
});
