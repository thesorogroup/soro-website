'use strict';
const PORTAL='https://thesorogroup.com/operations/';
const SENDER='Soro Group <do-not-reply@thesorogroup.com>';
function content(eventType,payload={}) {
  let title,message,subject,reference='';
  if(eventType==='support_ticket_created') {
    if(!/^SUP-[A-F0-9]{8}$/.test(payload.ticketNumber||''))throw new Error('Invalid ticket reference');
    title='Your support ticket is saved.';subject='We received your Soro support ticket';
    message='Thank you for letting us know. Your support ticket has been received by Soro.';reference=`Ticket ${payload.ticketNumber}`;
  }else if(eventType==='client_profile_updated') {
    title='Your changes are saved.';subject='Your Soro account information was updated';
    message='Your account information was updated in Soro Ops. If you did not make this change, open Help & Support in your portal.';
  }else throw new Error('Unsupported confirmation');
  // Only fixed copy and the validated, generated ticket reference enter email.
  const text=[title,message,reference,`Open Soro Ops: ${PORTAL}`,'Soro Group','This inbox is not monitored. Contact Soro through Help & Support in your portal.'].filter(Boolean).join('\n\n');
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#fff7ed"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#fff7ed"><tr><td align="center" style="padding:32px 14px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:660px;background:#fff;border-radius:24px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif"><tr><td align="center" style="padding:32px 28px 20px"><img src="https://thesorogroup.com/assets/soro-logo-final-transparent.png" width="210" alt="Soro Group" style="display:block;width:210px;max-width:100%;height:auto;border:0"></td></tr><tr><td style="padding:12px 32px 32px"><p style="margin:0 0 12px;color:#f45a1f;font-size:12px;font-weight:700;letter-spacing:1px">SORO OPS CONFIRMATION</p><h1 style="margin:0 0 18px;color:#082d5c;font-family:Georgia,serif;font-size:30px;font-weight:400;line-height:1.2">${title}</h1><p style="margin:0 0 22px;color:#35495f;font-size:16px;line-height:1.7">${message}</p>${reference?`<p style="padding:14px 18px;background:#fff8f2;border-left:4px solid #f45a1f;color:#082d5c;font-weight:700">${reference}</p>`:''}<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#f45a1f" style="border-radius:24px"><a href="${PORTAL}" style="display:inline-block;padding:15px 24px;color:#fff;text-decoration:none;font-size:15px;font-weight:700">Open Soro Ops</a></td></tr></table></td></tr><tr><td align="center" bgcolor="#082d5c" style="padding:24px 28px"><p style="margin:0 0 8px;color:#fff;font-size:13px;font-weight:700">Where businesses grow and talent thrives.</p><p style="margin:0;color:#d9e1e9;font-size:12px;line-height:1.6">This inbox is not monitored. Contact Soro through Help & Support in your portal.</p></td></tr></table></td></tr></table></body></html>`;
  return {subject,text,html};
}
module.exports={content,SENDER};
