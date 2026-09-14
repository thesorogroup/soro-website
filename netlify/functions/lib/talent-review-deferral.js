'use strict';

const { uuid, fail } = require('./portal-service');
const ITEM_KEYS = Object.freeze([
  'core_profile', 'resume', 'english', 'disc', 'enneagram', 'mbti',
  'internet', 'equipment', 'skills', 'interview', 'references'
]);

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validTimestamp(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)
    && validDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));
}

function publicDeferral(value) {
  if (value === null) return null;
  const invalid = () => fail(502, 'Talent review returned invalid deferral details.');
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !uuid(value.id) || typeof value.reason !== 'string' || !value.reason.trim()
    || value.reason.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.reason)
    || !validTimestamp(value.createdAt) || typeof value.createdByName !== 'string'
    || !value.createdByName.trim() || value.createdByName.length > 180
    || /[\u0000-\u001f]/.test(value.createdByName)
    || !(value.dueDate === null || validDate(value.dueDate))
    || !(value.taskId === null || uuid(value.taskId))
    || (value.dueDate === null) !== (value.taskId === null)) throw invalid();
  return {
    id: value.id.toLowerCase(),
    reason: value.reason.trim(),
    createdAt: value.createdAt,
    createdByName: value.createdByName.trim(),
    dueDate: value.dueDate,
    taskId: value.taskId === null ? null : value.taskId.toLowerCase()
  };
}

module.exports = { ITEM_KEYS, validDate, validTimestamp, publicDeferral };
