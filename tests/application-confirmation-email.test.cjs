'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {applicationConfirmationEmail, TALENT_EMAIL, APPLICATION_CONFIRMATION_FROM} = require('../netlify/functions/lib/application-confirmation-email');

test('Application confirmation includes the requested Philippine interview availability in both formats', () => {
  const email = applicationConfirmationEmail({firstName: 'Gabriel', lastName: 'Garin'});
  const expected = [
    'Hi Gabriel,',
    'Thank you for your interest in working with The Soro Group.',
    'experience, skills, and availability.',
    'All times listed are in Philippine Time (UTC+08:00).',
    'Monday: 12:00 AM – 1:00 PM',
    'Tuesday–Friday: 9:00 AM – 1:00 PM',
    'Saturday: 9:00 AM – 1:00 PM or 10:00 PM – 12:00 AM',
    'Sunday: 12:00 AM – 1:00 PM or 10:00 PM – 12:00 AM',
    'Please reply with your preferred interview date and time.',
    'You are welcome to send 2–3 options in case your first choice is no longer available.',
    'Once we receive your preferred date and time, we will add it to the calendar and send you an interview invite.',
    'We look forward to speaking with you.',
    'Best,',
    'The Soro Group Team',
    '12:00 AM means midnight at the end of that day.'
  ];
  for (const copy of expected) {
    assert.ok(email.text.includes(copy), `Plain text: ${copy}`);
    assert.ok(email.html.includes(copy), `HTML: ${copy}`);
  }
  assert.doesNotMatch(email.text + email.html, /Talent Management will contact you if|not monitored|Your interview is scheduled/);
  assert.doesNotMatch(email.html, /<a\b|\.ics\b|ConfirmationURL/);
  assert.match(email.html, /soro-logo-final-transparent\.png/);
  assert.match(email.html, /bgcolor="#082d5c"/);
  assert.match(email.html, /table role="presentation"/);
});

test('Application greeting preserves the first-name fix and honors preferred names', () => {
  for (const [person, name] of [
    [{full_name:'Garin, Gabriel Anda'}, 'Gabriel'],
    [{firstName:'Gabriel,',lastName:'Garin'}, 'Gabriel'],
    [{firstName:'Charles',preferredName:'Chuck'}, 'Chuck'],
    [{firstName:'Mary Anne'}, 'Mary Anne']
  ]) {
    const email = applicationConfirmationEmail(person);
    assert.ok(email.html.includes(`Hi ${name},`));
    assert.ok(email.text.includes(`Hi ${name},`));
    assert.doesNotMatch(email.html + email.text, /,,/);
  }
  const unknown = applicationConfirmationEmail({firstName:'<script>alert(1)</script>'});
  assert.match(unknown.html, /Hello,/);
  assert.doesNotMatch(unknown.html, /<script>/);
});

test('Applicant sender and reply destination use the same monitored Talent mailbox', () => {
  assert.equal(TALENT_EMAIL, 'talents@thesorogroup.com');
  assert.equal(APPLICATION_CONFIRMATION_FROM, 'The Soro Group <talents@thesorogroup.com>');
  const email = applicationConfirmationEmail({firstName:'Gabriel'});
  assert.ok(email.html.includes(TALENT_EMAIL));
  assert.ok(email.text.includes(TALENT_EMAIL));
});
