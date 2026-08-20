const shouldRun = process.env.EMAIL_DELIVERY_TEST === 'run-20260820-once';

if (!shouldRun) {
  console.log('Email delivery smoke test is disabled.');
  process.exit(0);
}

const apiKey = (process.env.RESEND_API_KEY || '').trim();
const from = (process.env.APPLICATION_FROM_EMAIL || '').trim();

if (!apiKey || !from) {
  throw new Error('Email delivery smoke test could not find the configured Resend key and sender.');
}

const messages = [
  {
    from,
    to: ['matt@thesorogroup.com'],
    subject: 'Soro Talent email test — applicant confirmation',
    text: 'This is a controlled delivery test for the Soro Talent application confirmation email. No applicant information is included.',
    html: '<p>This is a controlled delivery test for the Soro Talent application confirmation email.</p><p>No applicant information is included.</p>'
  },
  {
    from,
    to: ['talents@thesorogroup.com'],
    subject: 'Soro Talent email test — new application notification',
    text: 'This is a controlled delivery test for the Soro Talent Management application notification. No applicant information is included.',
    html: '<p>This is a controlled delivery test for the Soro Talent Management application notification.</p><p>No applicant information is included.</p>'
  }
];

for (const message of messages) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(message)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Email delivery smoke test failed (${response.status}). ${detail.slice(0, 200)}`);
  }
}

console.log('Email delivery smoke test sent both approved messages.');
