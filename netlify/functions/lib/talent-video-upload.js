'use strict';
const {createHash}=require('node:crypto');
const {fail}=require('./portal-service');
const MAX_VIDEO_BYTES=95*1024*1024;
const VIDEO_TYPES=['video/mp4','video/webm','video/quicktime'];

// Check the container signature, not the codec. Playback support still depends
// on the device; the uploader recommends H.264 MP4 and the player handles errors.
function verifyVideoHeader(bytes,type,total){
 if(!VIDEO_TYPES.includes(type)||!Buffer.isBuffer(bytes)||bytes.length<12)throw fail(400,'Use an MP4, WebM, or MOV video.');
 let valid=false;
 if(type==='video/webm'){
  valid=bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))&&bytes.subarray(0,4096).includes(Buffer.from('webm'));
 }else{
  const boxSize=bytes.readUInt32BE(0),boxType=bytes.toString('ascii',4,8);
  if(boxType==='ftyp'&&boxSize>=16&&boxSize<=total&&boxSize<=bytes.length){
   const brands=[];for(let pos=8;pos+4<=boxSize;pos+=4){if(pos!==12)brands.push(bytes.toString('ascii',pos,pos+4));}
   valid=type==='video/quicktime'?brands.includes('qt  '):brands.some(brand=>/^(isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(brand));
  }
 }
 if(!valid)throw fail(400,'The file contents do not match the selected video format. Export an H.264 MP4 and try again.');
}

async function verifyStoredVideo(response,expected,type){
 if(!Number.isInteger(expected)||expected<1||expected>MAX_VIDEO_BYTES)throw fail(400,'Choose a video up to 95 MiB.');
 if(!response.ok||!response.body)throw fail(400,'The video upload is not available yet. Try again.');
 const length=Number(response.headers.get('content-length'));
 if(length>MAX_VIDEO_BYTES||length>0&&length!==expected)throw fail(400,'The uploaded video size does not match.');
 const hash=createHash('sha256'),reader=response.body.getReader(),prefix=[];let size=0,prefixSize=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
   if(size>expected||size>MAX_VIDEO_BYTES)throw fail(400,'The uploaded video is too large.');
   hash.update(value);
   if(prefixSize<65536){const part=Buffer.from(value.subarray(0,65536-prefixSize));prefix.push(part);prefixSize+=part.length;}
  }
 }finally{await reader.cancel().catch(()=>{});}
 if(size!==expected)throw fail(400,'The video upload was incomplete. Choose it again to retry.');
 verifyVideoHeader(Buffer.concat(prefix),type,size);
 return {size,sha256:hash.digest('hex')};
}
module.exports={MAX_VIDEO_BYTES,VIDEO_TYPES,verifyVideoHeader,verifyStoredVideo};
