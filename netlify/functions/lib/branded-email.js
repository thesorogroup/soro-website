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

const INTERVIEW_CONFIDENTIALITY = 'This is a confidential interview invitation from The Soro Group. This invitation and meeting link are intended only for the invited participants. Please do not forward them without permission.';
const INTERVIEW_CONTACT_FOOTER = 'Questions about this interview? Contact talents@thesorogroup.com.';
const INTERVIEW_CONTACT_FOOTER_HTML = 'Questions about this interview? Contact <a href="mailto:talents@thesorogroup.com" style="color:#ffffff;text-decoration:underline;text-underline-offset:3px">talents@thesorogroup.com</a>.';

function interviewTimezone(value) {
  try {
    if (typeof value !== 'string' || value.length > 100 || /^[+-]/.test(value)) return 'UTC';
    return new Intl.DateTimeFormat('en-US', {timeZone: value}).resolvedOptions().timeZone;
  } catch { return 'UTC'; }
}

function interviewSchedule(schedule = {}) {
  if (!schedule.startsAt && !schedule.endsAt) return [];
  const start = new Date(schedule.startsAt), end = new Date(schedule.endsAt);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) throw new Error('Invalid interview schedule.');
  const zone = interviewTimezone(schedule.timezone);
  const zones = [...new Set(['Asia/Manila', zone])];
  return zones.map(timeZone => {
    const fmt = opts => new Intl.DateTimeFormat('en-US', {timeZone, ...opts});
    const day = fmt({weekday:'long',year:'numeric',month:'long',day:'numeric'});
    const time = fmt({hour:'numeric',minute:'2-digit',hour12:true});
    const offset = instant => fmt({timeZoneName:'longOffset'}).formatToParts(instant).find(p=>p.type==='timeZoneName').value.replace('GMT','UTC').replace(/^UTC$/, 'UTC+00:00');
    const firstOffset = offset(start), lastOffset = offset(end);
    const endLabel = day.format(start) === day.format(end) ? time.format(end) : `${day.format(end)} · ${time.format(end)}`;
    const label = timeZone === 'Asia/Manila' ? 'Philippine Time' : timeZone === 'UTC' ? 'Coordinated Universal Time' : 'Scheduling time zone';
    return [label, `${day.format(start)} · ${time.format(start)} – ${endLabel} · ${timeZone} (${firstOffset}${firstOffset===lastOffset?'':` → ${lastOffset}`})`];
  });
}

function interviewScheduleBlock(schedule) {
  const rows = interviewSchedule(schedule);
  if (!rows.length) return '';
  return `<table id="soro-interview-schedule" role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f4f7fb" style="margin:22px 0;border:1px solid #dce5ef;border-radius:12px"><tr><td style="padding:18px 20px 4px;color:#082d5c;font:700 14px 'Segoe UI',Arial,sans-serif">INTERVIEW DATE &amp; TIME</td></tr>${rows.map(([label,value])=>`<tr><td style="padding:12px 20px 18px"><p style="margin:0 0 6px;color:#ba4419;font:700 14px 'Segoe UI',Arial,sans-serif">${escapeHtml(label)}</p><p style="margin:0;color:#082d5c;font:16px/1.6 'Segoe UI',Arial,sans-serif">${escapeHtml(value).replaceAll(' · ', '<br>')}</p></td></tr>`).join('')}</table>`;
}

function interviewEmail(audience, schedule = {}) {
  if (!['Talent', 'Client'].includes(audience)) throw new Error('Invalid interview audience.');
  // The same calendar body goes to all attendees: never greet the entire group
  // with one person's name or include internal feedback/private profile data.
  const email = renderEmail({
    subject: `Your Soro ${audience} interview`, eyebrow: 'YOUR SORO INTERVIEW',
    title: audience === 'Talent' ? 'Your interview with The Soro Group.' : 'Let’s meet your next teammate.',
    paragraphs: ['Your interview is scheduled. Open this calendar invitation to see the date and time in your calendar’s configured time zone.', 'Use the Microsoft Teams meeting details in this invitation to join.'],
    steps: [['Before the interview', 'Check your microphone, camera, and internet connection.'], ['Need to make a change?', 'Contact your Soro coordinator to arrange a new time.']],
    note: INTERVIEW_CONFIDENTIALITY,
    footer: INTERVIEW_CONTACT_FOOTER
  });
  // Only this fixed, trusted contact link becomes HTML; caller text stays escaped.
  email.html = email.html.replace(escapeHtml(INTERVIEW_CONTACT_FOOTER), INTERVIEW_CONTACT_FOOTER_HTML);
  const block = interviewScheduleBlock(schedule);
  if (block) {
    email.html = email.html.replace(/(<p\b[^>]*>Use the Microsoft Teams meeting details in this invitation to join\.<\/p>)/, `$1${block}`);
    email.text = email.text.replace('Use the Microsoft Teams meeting details in this invitation to join.', `Use the Microsoft Teams meeting details in this invitation to join.\n\nINTERVIEW DATE & TIME\n${interviewSchedule(schedule).map(([label,value])=>`${label}: ${value}`).join('\n\n')}`);
  }
  return email;
}

// Change only our bounded schedule/copy. The surrounding Microsoft Teams meeting
// block must be retained when rescheduling an existing online meeting.
function updateInterviewBody(existing, audience, schedule) {
  if (existing?.contentType?.toLowerCase() !== 'html' || typeof existing.content !== 'string' || existing.content.length > 1000000) throw new Error('Calendar body is unavailable.');
  const block = interviewScheduleBlock(schedule);
  if (!block) throw new Error('Interview schedule is required.');
  let html = existing.content;
  const visible = paragraph => paragraph.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;|&#x0*a0;/gi,' ').replace(/&rsquo;|&#8217;|&#x2019;/gi,'’').replace(/\s+/g,' ').trim();
  const schedulePattern = /<table\b[^>]*\bid\s*=\s*["']soro-interview-schedule["'][^>]*>[\s\S]*?<\/table\s*>/gi;
  const matches = [...html.matchAll(schedulePattern)];
  if (matches.length === 1 && !/<table\b/i.test(matches[0][0].slice(6))) html = html.replace(schedulePattern, () => block);
  else if (matches.length === 0 && !/soro-interview-schedule|INTERVIEW DATE (?:&amp;|&) TIME/i.test(html)) {
    // Legacy invitation has no fixed date block. Insert beside the original
    // appointment paragraph; do not reconstruct or discard the Teams details.
    const anchors = [...html.matchAll(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi)].filter(match => visible(match[0]).startsWith('Your interview is scheduled.'));
    if (anchors.length !== 1) throw new Error('Calendar body needs review before rescheduling.');
    const anchor = anchors[0];
    html = html.slice(0,anchor.index) + anchor[0] + block + html.slice(anchor.index+anchor[0].length);
  } else throw new Error('Calendar schedule block needs review.');
  html = html.replaceAll('Private review notes and decisions stay in Soro Ops.', escapeHtml(INTERVIEW_CONFIDENTIALITY));
  html = html.replace(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi, paragraph => visible(paragraph) === 'Private review notes and decisions stay in Soro Ops.'
    ? paragraph.replace(/(>)[\s\S]*(<\/p\s*>)/i, `$1${escapeHtml(INTERVIEW_CONFIDENTIALITY)}$2`) : paragraph);
  html = html.replaceAll('Your interview is scheduled. The date and time in this calendar invitation will display in your local time zone.', 'Your interview is scheduled. Open this calendar invitation to see the date and time in your calendar’s configured time zone.');
  html = html.replace(/<p\b[^>]*>[\s\S]*?<\/p\s*>/gi, paragraph => visible(paragraph) === 'Questions about this interview? Contact your Soro coordinator.'
    ? paragraph.replace(/(>)[\s\S]*(<\/p\s*>)/i, `$1${INTERVIEW_CONTACT_FOOTER_HTML}$2`) : paragraph);
  if (audience === 'Talent') html = html.replaceAll('Let’s meet your next teammate.', 'Your interview with The Soro Group.');
  return {contentType:'HTML', content:html};
}

module.exports = {PORTAL, LOGO, FOOTER, escapeHtml, firstName, greeting, renderEmail, accessEmail, interviewEmail, interviewTimezone, interviewSchedule, updateInterviewBody};
