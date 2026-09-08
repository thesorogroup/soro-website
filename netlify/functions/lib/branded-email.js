'use strict';

// Shared, email-client-friendly Soro presentation. All caller content is text,
// never raw HTML. Authentication link creation and delivery stay with callers.
const PORTAL = 'https://thesorogroup.com/operations/';
const LOGO = 'https://thesorogroup.com/assets/soro-logo-final-transparent.png';
const FOOTER = 'This inbox is not monitored. Contact Soro through Help & Support in your portal.';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : '';
const suffix = value => /^(?:jr|sr|ii|iii|iv|v)\.?$/i.test(value);

function namePart(value) {
  const text = clean(value).replace(/^[\s,.;:!?]+|[\s,.;:!?]+$/g, '');
  // Do not turn an email, markup, initials-only entry, or placeholder into a name.
  return text.length <= 80 && /^[\p{L}][\p{L}\p{M}'’\- .]*$/u.test(text)
    && !/^(?:there|unknown|not (?:shared|recorded)|n\/?a|soro(?: talent)?|new talent applicant)$/i.test(text)
    && !text.replaceAll('.', ' ').trim().split(/\s+/).every(part => /^\p{L}$/u.test(part)) ? text : '';
}

function firstName(person = {}) {
  if (!person || typeof person !== 'object' && typeof person !== 'string') return '';
  if (typeof person === 'string') person = {full_name: person};
  const preferred = namePart(person.preferredName || person.preferred_name);
  if (preferred) return preferred;
  // Structured current first names are authoritative; never consult legacy blobs.
  const given = namePart(person.firstName || person.first_name);
  if (given) return given;
  const full = clean(person.full_name || person.fullName || person.display_name);
  if (!full || full.length > 240 || /[@<>]/.test(full)) return '';
  if (/^(?:unknown|not (?:shared|recorded)|n\/?a|soro(?: talent)?|new talent applicant)[,.;:!?]*$/i.test(full)) return '';
  const parts = full.split(',').map(part => part.trim()).filter(Boolean);
  // Applicants are stored "Family, Given Middle". Natural-order names with a
  // trailing suffix ("Gabriel Garin, Jr.") retain the first component instead.
  const inverted = parts.slice(1).find(part => !suffix(part));
  if (full.includes(',') && !inverted && parts.length === 1) return '';
  const givenSide = inverted || parts[0] || '';
  const withoutTitle = givenSide.replace(/^(?:(?:mr|mrs|ms|miss|mx|dr|prof)\.?\s+)+/i, '');
  return namePart(withoutTitle.split(/\s+/)[0]);
}

function greeting(person) {
  const name = firstName(person);
  return name ? `Hi ${name},` : 'Hello,';
}

function safeUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Email links must use HTTPS.');
  return url.toString();
}

function renderEmail({subject, eyebrow = 'SORO GROUP', title, person, paragraphs = [], steps = [], reference = '', action, note = '', footer = FOOTER, preheader = ''}) {
  const salutation = person === undefined ? '' : greeting(person);
  const url = action ? safeUrl(action.url) : '';
  const text = [salutation, title, ...paragraphs, reference, ...steps.map(([heading, detail]) => `${heading}: ${detail}`), action ? `${action.label}: ${url}` : '', note, 'Soro Group', footer].filter(Boolean).join('\n\n');
  const e = escapeHtml;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(subject)}</title></head><body style="margin:0;background:#fff7ed"><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${e(preheader || title)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#fff7ed"><tr><td align="center" style="padding:28px 12px"><!--[if mso]><table role="presentation" width="640"><tr><td><![endif]--><table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;font-family:'Segoe UI',Arial,sans-serif"><tr><td align="center" style="padding:32px 24px 26px;border-bottom:1px solid #edf0f4"><img src="${LOGO}" width="200" alt="Soro Group" style="display:block;width:200px;max-width:100%;height:auto;border:0"></td></tr><tr><td style="padding:32px 28px 12px"><p style="margin:0 0 14px;color:#ba4419;font-size:12px;font-weight:700;letter-spacing:1.4px">${e(eyebrow)}</p><h1 style="margin:0 0 18px;color:#082d5c;font-family:Georgia,serif;font-size:32px;font-weight:400;line-height:1.2">${e(title)}</h1>${salutation ? `<p style="margin:0 0 14px;color:#082d5c;font-size:16px;line-height:1.7">${e(salutation)}</p>` : ''}${paragraphs.map(p => `<p style="margin:0 0 14px;color:#35495f;font-size:16px;line-height:1.7">${e(p)}</p>`).join('')}${reference ? `<p style="padding:14px 18px;background:#f4f7fb;border-left:4px solid #c9430b;color:#082d5c;font-size:16px;font-weight:700">${e(reference)}</p>` : ''}</td></tr>${steps.length ? `<tr><td style="padding:16px 28px 26px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4f7fb" style="border:1px solid #e1e8f1;border-radius:12px">${steps.map(([heading, detail], i) => `<tr><td valign="top" width="28" style="padding:${i ? '0' : '20px'} 0 20px 18px;color:#ba4419;font-size:16px;font-weight:700">${i + 1}.</td><td style="padding:${i ? '0' : '20px'} 18px 20px 10px"><p style="margin:0 0 4px;color:#082d5c;font-size:15px;font-weight:700">${e(heading)}</p><p style="margin:0;color:#4b5e73;font-size:14px;line-height:1.6">${e(detail)}</p></td></tr>`).join('')}</table></td></tr>` : ''}<tr><td style="padding:8px 28px 32px">${action ? `<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#c9430b" style="border-radius:8px;text-align:center"><a href="${e(url)}" style="display:inline-block;padding:16px 24px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;mso-padding-alt:0"><!--[if mso]><i style="mso-font-width:150%;mso-text-raise:24pt" hidden>&emsp;</i><![endif]--><span style="mso-text-raise:12pt">${e(action.label)}</span><!--[if mso]><i style="mso-font-width:150%" hidden>&emsp;&#8203;</i><![endif]--></a></td></tr></table>` : ''}${note ? `<p style="margin:18px 0 0;color:#5a6c7e;font-size:13px;line-height:1.6">${e(note)}</p>` : ''}</td></tr><tr><td align="center" bgcolor="#082d5c" style="padding:24px"><p style="margin:0 0 10px;color:#ffffff;font-size:14px;font-weight:600">Where businesses grow and talent thrives.</p><p style="margin:0;color:#d9e1e9;font-size:12px;line-height:1.7">${e(footer)}</p></td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  return {subject, text, html};
}

function accessEmail({person, actionLink, kind, audience = 'Talent'}) {
  if (!['Talent', 'Client'].includes(audience)) throw new Error('Invalid portal audience.');
  const setup = kind !== 'password_reset';
  const portal = `Soro ${audience} Portal`;
  return renderEmail({
    subject: setup ? `Set up your ${portal} access` : `Reset your ${portal} password`,
    eyebrow: setup ? 'YOUR SECURE PORTAL INVITATION' : 'SECURE PASSWORD RESET',
    title: setup ? 'Welcome to your Soro portal.' : 'Let’s get you signed in again.',
    person,
    paragraphs: [setup ? `Use the secure button below to create your private password and finish setting up your ${portal} access.` : `Use the secure button below to choose a new password for your ${portal} account.`],
    action: {label: setup ? 'Finish account setup' : 'Reset password', url: actionLink},
    note: 'If you were not expecting this email, contact Soro Group. Do not forward this secure one-use link.'
  });
}

function interviewEmail(audience) {
  if (!['Talent', 'Client'].includes(audience)) throw new Error('Invalid interview audience.');
  // The same calendar body goes to all attendees: never greet the entire group
  // with one person's name or include internal feedback/private profile data.
  return renderEmail({
    subject: `Your Soro ${audience} interview`, eyebrow: 'YOUR SORO INTERVIEW',
    title: 'Let’s meet your next teammate.',
    paragraphs: ['Your interview is scheduled. The date and time in this calendar invitation will display in your local time zone.', 'Use the Microsoft Teams meeting details in this invitation to join.'],
    steps: [['Before the interview', 'Check your microphone, camera, and internet connection.'], ['Need to make a change?', 'Contact your Soro coordinator to arrange a new time.']],
    note: 'Private review notes and decisions stay in Soro Ops.',
    footer: 'Questions about this interview? Contact your Soro coordinator.'
  });
}

module.exports = {PORTAL, LOGO, FOOTER, escapeHtml, firstName, greeting, renderEmail, accessEmail, interviewEmail};
