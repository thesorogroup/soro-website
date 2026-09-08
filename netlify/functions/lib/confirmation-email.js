'use strict';
const {renderEmail, PORTAL} = require('./branded-email');
const SENDER = 'Soro Group <do-not-reply@thesorogroup.com>';
const SHORTLIST_TYPES = new Set(['client_shortlist_ready', 'client_shortlist_response']);

function shortlistContent(eventType, payload = {}, person = {}) {
  const ready = eventType === 'client_shortlist_ready';
  if (payload.requestId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(payload.requestId)) throw new Error('Invalid request reference');
  const url = PORTAL + (payload.requestId ? `${ready ? '#client-candidate-review' : '#client-placement'}/${payload.requestId}` : (ready ? '#client-candidate-review' : '#client-shortlists'));
  return renderEmail({
    subject: ready ? 'Your Soro candidates are ready to review' : 'Your client has responded to a Soro candidate',
    eyebrow: ready ? 'YOUR CANDIDATE SHORTLIST' : 'CLIENT REVIEW UPDATE',
    title: ready ? 'Meet your potential next teammate.' : 'Your client has shared their feedback.',
    person,
    paragraphs: [ready ? 'Your Soro team has prepared a candidate shortlist for you. Sign in to explore the profiles and let us know who you would like to meet.' : 'A client has responded to a candidate in their shortlist. Open the hiring request to see the response and coordinate the next step.'],
    steps: ready ? [
      ['Explore the profiles', 'Review the skills, experience, and approved screening summaries.'],
      ['Share your feedback', 'Express interest or request an interview. Client Admins can also pass on a candidate.']
    ] : [
      ['Review the response', 'See whether the client is interested, requests an interview, or has passed.'],
      ['Coordinate the next step', 'Use the existing interview and selection workflow to keep everyone moving together.']
    ],
    action: {label: ready ? 'Review your candidates' : 'View client response', url},
    note: ready ? 'Candidate details are available only in your signed-in portal.' : 'Internal update for the assigned Sales associate. Client and candidate details stay in Soro Ops.'
  });
}

function content(eventType, payload = {}, person = {}) {
  if (SHORTLIST_TYPES.has(eventType)) return shortlistContent(eventType, payload, person);
  let title, message, subject, reference = '';
  if (eventType === 'support_ticket_created') {
    title = 'Your support ticket is saved.'; subject = 'We received your Soro support ticket';
    message = 'Thank you for letting us know. Your support ticket has been received by Soro.';
  } else if (['support_ticket_reply', 'support_ticket_resolved', 'support_ticket_assigned'].includes(eventType)) {
    [title, subject, message] = {
      support_ticket_reply: ['There is a new reply.', 'New reply on your Soro support ticket', 'A new reply is available in your support conversation. Sign in to read it and respond.'],
      support_ticket_resolved: ['Your support ticket is resolved.', 'Your Soro support ticket was resolved', 'Soro marked your support ticket as resolved. If you still need help, reply to the ticket in your portal.'],
      support_ticket_assigned: ['A support ticket needs attention.', 'Soro support ticket assignment', 'A support ticket is available for you in Help & Support. Sign in to review the details.']
    }[eventType];
  } else if (eventType === 'client_profile_updated') {
    title = 'Your changes are saved.'; subject = 'Your Soro account information was updated';
    message = 'Your account information was updated in Soro Ops. If you did not make this change, open Help & Support in your portal.';
  } else throw new Error('Unsupported confirmation');
  if (eventType.startsWith('support_ticket_')) {
    if (!/^SUP-[A-F0-9]{8}$/.test(payload.ticketNumber || '')) throw new Error('Invalid ticket reference');
    reference = `Ticket ${payload.ticketNumber}`;
  }
  // Only fixed copy, validated references and separately resolved recipient names.
  // Ticket text, attachments, client/candidate data and links never enter this body.
  return renderEmail({subject, title, person, eyebrow: 'SORO OPS CONFIRMATION', paragraphs: [message], reference, action: {label: 'Open Soro Ops', url: PORTAL}});
}
module.exports = {content, SENDER};
