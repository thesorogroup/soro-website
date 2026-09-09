'use strict';

const {renderEmail} = require('./branded-email');

// Applicant replies go to the Talent team's monitored mailbox, not the general
// no-reply sender or the configurable destination of internal staff notices.
const TALENT_EMAIL = 'talents@thesorogroup.com';
const APPLICATION_CONFIRMATION_FROM = `The Soro Group <${TALENT_EMAIL}>`;

function applicationConfirmationEmail(person) {
  return renderEmail({
    subject: 'Application received — let’s schedule your Soro interview',
    eyebrow: 'APPLICATION RECEIVED · NEXT STEP',
    title: 'Let’s schedule your interview.',
    preheader: 'Reply with 2–3 preferred interview dates and times in Philippine Time.',
    person,
    paragraphs: [
      'Thank you for your interest in working with The Soro Group. We would like to schedule an interview with you to learn more about your experience, skills, and availability.',
      'Please choose a specific date and time that works best for you based on the interview availability below. All times listed are in Philippine Time (UTC+08:00).',
      'Monday: 12:00 AM – 1:00 PM',
      'Tuesday–Friday: 9:00 AM – 1:00 PM',
      'Saturday: 9:00 AM – 1:00 PM or 10:00 PM – 12:00 AM',
      'Sunday: 12:00 AM – 1:00 PM or 10:00 PM – 12:00 AM',
      'Please reply with your preferred interview date and time. You are welcome to send 2–3 options in case your first choice is no longer available.',
      'Once we receive your preferred date and time, we will add it to the calendar and send you an interview invite.',
      'We look forward to speaking with you.',
      'Best,',
      'The Soro Group Team'
    ],
    note: 'For the 10:00 PM – 12:00 AM windows, 12:00 AM means midnight at the end of that day.',
    footer: `Reply to this email to reach our Talent team at ${TALENT_EMAIL}.`
  });
}

module.exports = {TALENT_EMAIL, APPLICATION_CONFIRMATION_FROM, applicationConfirmationEmail};
