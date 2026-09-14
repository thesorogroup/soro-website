'use strict';

const LIMITS = Object.freeze({ name: 160, relationship: 120, email: 254, phone: 60 });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeApplicationReferences(value, { validateEmail = false } = {}) {
  if (value === undefined) return [];
  const invalid = message => { const error = new Error(message); error.statusCode = 400; throw error; };
  if (!Array.isArray(value) || value.length > 3) invalid('Please provide no more than three references.');
  return value.map(reference => {
    if (!reference || typeof reference !== 'object' || Array.isArray(reference)) invalid('Please check the reference details and try again.');
    const result = {};
    for (const [key, maximum] of Object.entries(LIMITS)) {
      const field = reference[key] ?? '';
      if (typeof field !== 'string' || field.length > maximum || /\u0000/.test(field)) invalid(`Please check the reference ${key} (up to ${maximum} characters).`);
      result[key] = field.trim();
    }
    if (validateEmail && result.email && !EMAIL.test(result.email)) invalid('Please enter a valid reference email address, or leave it blank.');
    return result;
  }).filter(reference => Object.values(reference).some(Boolean));
}

function validateReferenceConsent(data) {
  const references = normalizeApplicationReferences(data.references, { validateEmail: true });
  if (references.length && data.referenceContactConsent !== true) {
    const error = new Error('Please check the permission box allowing The Soro Group to contact your references, or remove the reference details.');
    error.statusCode = 400;
    throw error;
  }
  return references;
}

module.exports = { normalizeApplicationReferences, validateReferenceConsent };
