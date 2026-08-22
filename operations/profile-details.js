/* Private Talent profile-detail helpers shared by the browser and tests. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.soroProfileDetails = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MANAGER_ROLES = new Set(['admin', 'talent_management']);
  const GENDER_IDENTITIES = new Set(['female', 'male', 'nonbinary', 'self_describe', 'prefer_not_to_disclose']);
  const EARLIEST_BIRTH_DATE = '1900-01-01';
  const MONTH_NAMES = Object.freeze(['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

  function normalizedRole(value) {
    return String(value || '').trim().toLowerCase();
  }

  function canManageProfileDetails(role) {
    return MANAGER_ROLES.has(normalizedRole(role));
  }

  function canViewPrivateProfileDetails({ role, userId, applicantAuthUserId } = {}) {
    if (canManageProfileDetails(role)) return true;
    return normalizedRole(role) === 'virtual_assistant'
      && Boolean(userId)
      && Boolean(applicantAuthUserId)
      && String(userId) === String(applicantAuthUserId);
  }

  function isLeapYear(year) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  }

  function daysInMonth(year, month) {
    return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] || 0;
  }

  function parseIsoCalendarDate(value) {
    const text = String(value || '').trim();
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
    return Object.freeze({ year, month, day, iso: `${match[1]}-${match[2]}-${match[3]}` });
  }

  function formattedCalendarParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return Object.freeze({
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      iso: `${values.year}-${values.month}-${values.day}`
    });
  }

  function calendarDateForInstant(instant = new Date(), timeZone = '') {
    const date = instant instanceof Date ? instant : new Date(instant);
    if (!Number.isFinite(date.getTime())) throw new TypeError('A valid current instant is required.');
    const requestedZone = String(timeZone || '').trim();
    const zone = requestedZone && requestedZone.toLowerCase() !== 'other' ? requestedZone : 'UTC';
    try {
      const values = formattedCalendarParts(date, zone);
      return Object.freeze({
        ...values,
        timeZone: zone,
        usedFallback: zone === 'UTC' && requestedZone !== 'UTC'
      });
    } catch (_error) {
      return Object.freeze({
        ...formattedCalendarParts(date, 'UTC'),
        timeZone: 'UTC',
        usedFallback: true
      });
    }
  }

  function compareCalendarDates(left, right) {
    return (left.year - right.year) || (left.month - right.month) || (left.day - right.day);
  }

  function ageFromBirthDate(value, timeZone, instant = new Date()) {
    const birthDate = parseIsoCalendarDate(value);
    if (!birthDate) return null;
    const today = calendarDateForInstant(instant, timeZone);
    if (compareCalendarDates(birthDate, today) > 0) return null;
    // Calendar birthdays are used rather than elapsed milliseconds. A Feb. 29
    // birthday therefore advances on Mar. 1 during non-leap years.
    let age = today.year - birthDate.year;
    if (today.month < birthDate.month || (today.month === birthDate.month && today.day < birthDate.day)) age -= 1;
    return age;
  }

  function validateBirthDate(value, timeZone, instant = new Date()) {
    const text = String(value || '').trim();
    if (!text) return Object.freeze({ valid: true, value: null, error: '' });
    const birthDate = parseIsoCalendarDate(text);
    if (!birthDate) return Object.freeze({ valid: false, value: null, error: 'Enter a valid date of birth in YYYY-MM-DD format.' });
    if (birthDate.iso < EARLIEST_BIRTH_DATE) return Object.freeze({ valid: false, value: null, error: `Date of birth cannot be earlier than ${EARLIEST_BIRTH_DATE}.` });
    const today = calendarDateForInstant(instant, timeZone);
    if (compareCalendarDates(birthDate, today) > 0) return Object.freeze({ valid: false, value: null, error: 'Date of birth cannot be in the future.' });
    return Object.freeze({ valid: true, value: birthDate.iso, error: '' });
  }

  function formatBirthDate(value) {
    const date = parseIsoCalendarDate(value);
    return date ? `${MONTH_NAMES[date.month - 1]} ${date.day}, ${date.year}` : 'Not recorded';
  }

  function buildPrivateProfileUpdate({ birthDate, genderIdentity, genderSelfDescription, timeZone, instant } = {}) {
    const validatedBirthDate = validateBirthDate(birthDate, timeZone, instant);
    if (!validatedBirthDate.valid) throw new TypeError(validatedBirthDate.error);
    const gender = String(genderIdentity || '').trim();
    const selfDescription = String(genderSelfDescription || '').trim();
    if (gender && !GENDER_IDENTITIES.has(gender)) throw new TypeError('Gender identity selection is not recognized.');
    if (gender === 'self_describe' && !selfDescription) throw new TypeError('Enter the gender wording the Talent asked Soro to use.');
    if (selfDescription.length > 120) throw new TypeError('Gender self-description must be 120 characters or fewer.');
    return Object.freeze({
      birth_date: validatedBirthDate.value,
      gender_identity: gender || null,
      gender_identity_self_description: gender === 'self_describe' ? selfDescription : null
    });
  }

  function computerDeviceState(hasLaptop) {
    if (hasLaptop === true) return Object.freeze({ kind: 'laptop', label: 'Laptop reported' });
    if (hasLaptop === false) return Object.freeze({ kind: 'desktop', label: 'No laptop reported' });
    return Object.freeze({ kind: 'generic', label: 'Device type not recorded' });
  }

  return Object.freeze({
    EARLIEST_BIRTH_DATE,
    canManageProfileDetails,
    canViewPrivateProfileDetails,
    parseIsoCalendarDate,
    calendarDateForInstant,
    ageFromBirthDate,
    validateBirthDate,
    formatBirthDate,
    buildPrivateProfileUpdate,
    computerDeviceState
  });
}));
