'use strict';
const {renderEmail}=require('./branded-email');
const {TALENT_EMAIL,APPLICATION_CONFIRMATION_FROM}=require('./application-confirmation-email');
const {uuid}=require('./portal-service');
function content(payload){
 if(!uuid(payload?.taskId)||typeof payload.details!=='string'||!payload.details.trim()||payload.details.length>4000)throw new Error('Invalid applicant request.');
 const email=renderEmail({subject:'A next step for your Soro application',eyebrow:'APPLICATION FOLLOW-UP',title:'We need a little more information.',person:{full_name:payload.personName},paragraphs:['Thank you for your interest in The Soro Group. Please review the request from our Talent team below.',...payload.details.split(/\n+/).filter(Boolean),'Open your task to view the request and send a response. If you need to sign in first, you will return directly to this task afterward.'],action:{label:'Open Task',url:`https://thesorogroup.com/operations/#tasks/${payload.taskId}`},note:'If your Talent Portal access has not been activated yet, or you cannot sign in, simply reply to this email with the requested information. Opening this link does not activate an account.',footer:`Questions? Reply to our Talent team at ${TALENT_EMAIL}. This message concerns your application with The Soro Group.`});
 return {from:APPLICATION_CONFIRMATION_FROM,reply_to:TALENT_EMAIL,...email};
}
module.exports={content};
