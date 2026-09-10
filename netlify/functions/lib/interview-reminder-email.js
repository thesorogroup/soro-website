'use strict';
const {renderEmail,interviewSchedule,escapeHtml}=require('./branded-email');
const {TALENT_EMAIL,APPLICATION_CONFIRMATION_FROM}=require('./application-confirmation-email');
function content(payload={}) {
  const url=new URL(payload.joinUrl);
  if(url.protocol!=='https:' || url.username || url.password || !['teams.microsoft.com','teams.live.com'].includes(url.hostname)) throw new Error('A verified Teams meeting link is required.');
  if(![1440,60].includes(payload.offsetMinutes)) throw new Error('Invalid reminder interval.');
  const times=interviewSchedule(payload);
  if(!times.length) throw new Error('An interview schedule is required.');
  const footer=`Questions or need to reschedule? Contact ${TALENT_EMAIL}.`;
  const email=renderEmail({
    subject:`Interview reminder — ${payload.offsetMinutes===1440?'24 hours':'1 hour'}`,
    eyebrow:'YOUR SORO INTERVIEW',title:'Your interview is coming up.',person:{full_name:payload.personName},
    paragraphs:[`${payload.recipientKind==='staff' ? `You’re invited to the interview with ${payload.applicantName}.` : 'We look forward to speaking with you at your interview with The Soro Group.'} Please check the date and time below. Your calendar invitation also shows the appointment in your calendar’s configured time zone.`],
    steps:[...times,['Before joining','Check your microphone, camera, and internet connection.']],
    action:{label:'Join Microsoft Teams meeting',url:url.href},
    note:'This is a confidential interview reminder from The Soro Group. The invitation and meeting link are intended only for invited participants. Please do not forward them without permission.',footer
  });
  email.html=email.html.replace(escapeHtml(footer),`Questions or need to reschedule? Contact <a href="mailto:${TALENT_EMAIL}" style="color:#ffffff;text-decoration:underline">${TALENT_EMAIL}</a>.`);
  return {from:APPLICATION_CONFIRMATION_FROM,reply_to:TALENT_EMAIL,...email};
}
module.exports={content};
