'use strict';
const crypto=require('node:crypto');
const {fail}=require('./portal-service');
const {parseImage}=require('../support-tickets');
const {_test:{dimensions}}=require('../work-log');
// The browser re-encodes all supported input formats as a baseline JPEG. Strip
// metadata again at the trust boundary, including EXIF/GPS and trailing bytes.
function inspirationImage(input){
 const parsed=parseImage(input),bad=()=>fail(400,'This photo could not be prepared. Choose another JPG, PNG, or WebP image.');
 if(parsed?.type!=='image/jpeg')throw bad();
 const b=parsed.bytes,out=[b.subarray(0,2)];let pos=2,sawFrame=false;
 while(pos<b.length){
  if(b[pos]!==255)throw bad();const begin=pos++;while(b[pos]===255)pos++;const marker=b[pos++];
  if(marker===0xda){
   if(!sawFrame||pos+2>b.length)throw bad();const len=b.readUInt16BE(pos);if(len<2||pos+len>b.length)throw bad();
   pos+=len;
   while(pos<b.length-1){if(b[pos++]!==255)continue;let m=b[pos++];while(m===255)m=b[pos++];if(m===0||(m>=0xd0&&m<=0xd7))continue;
    if(m!==0xd9)throw bad();out.push(b.subarray(begin,pos));const bytes=Buffer.concat(out);
    try{return dimensions({...parsed,bytes,sha256:crypto.createHash('sha256').update(bytes).digest('hex')});}catch{throw bad();}
   }throw bad();
  }
  if(pos+2>b.length)throw bad();const len=b.readUInt16BE(pos);if(len<2||pos+len>b.length)throw bad();
  if(marker===0xc0)sawFrame=true;
  // Only baseline decoding segments and ordinary JFIF are needed after canvas.
  if([0xc0,0xc4,0xdb,0xdd].includes(marker)||(marker===0xe0&&b.toString('ascii',pos+2,pos+7)==='JFIF\0'))out.push(b.subarray(begin,pos+len));
  else if(!(marker>=0xe0&&marker<=0xef)&&marker!==0xfe)throw bad();
  pos+=len;
 }throw bad();
}
module.exports={inspirationImage};
