'use strict';

const { actor, service, json, uuid, fail } = require('./lib/portal-service');
const { publicPayload: publicQueue } = require('./talent-review-queue');
const { ITEM_KEYS, validDate, validTimestamp, publicDeferral } = require('./lib/talent-review-deferral');
const POST_KEYS = Object.freeze([
  'requestId', 'applicantId', 'expectedUpdatedAt', 'itemKey', 'action', 'reason', 'dueDate', 'createTask'
]);
const MAX_REQUEST_BYTES = 8192;

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function queryApplicant(event) {
  const query = event.queryStringParameters || {};
  const multi = event.multiValueQueryStringParameters || {};
  if (!exactKeys(query, ['applicantId']) || !uuid(query.applicantId)
    || String(event.body || '').trim() || event.isBase64Encoded
    || (Object.keys(multi).length && (!exactKeys(multi, ['applicantId'])
      || !Array.isArray(multi.applicantId) || multi.applicantId.length !== 1
      || multi.applicantId[0] !== query.applicantId))) {
    throw fail(400, 'Choose one valid Talent application.');
  }
  if (event.rawQueryString) {
    const raw = [...new URLSearchParams(event.rawQueryString)];
    if (raw.length !== 1 || raw[0][0] !== 'applicantId' || raw[0][1] !== query.applicantId) {
      throw fail(400, 'Choose one valid Talent application.');
    }
  }
  return query.applicantId.toLowerCase();
}

function postInput(event) {
  if (Object.keys(event.queryStringParameters || {}).length
    || Object.keys(event.multiValueQueryStringParameters || {}).length || event.rawQueryString) {
    throw fail(400, 'Only the required review details are accepted.');
  }
  if (event.isBase64Encoded || typeof event.body !== 'string') throw fail(400, 'The review request could not be read.');
  if (Buffer.byteLength(event.body, 'utf8') > MAX_REQUEST_BYTES) throw fail(413, 'The review request is too large.');
  let body;
  try { body = JSON.parse(event.body); } catch { throw fail(400, 'The review request could not be read.'); }
  if (!exactKeys(body, POST_KEYS)) throw fail(400, 'Only the required review details are accepted.');
  if (!uuid(body.requestId) || !uuid(body.applicantId) || !validTimestamp(body.expectedUpdatedAt)
    || !ITEM_KEYS.includes(body.itemKey) || !['defer', 'restore'].includes(body.action)
    || typeof body.createTask !== 'boolean') throw fail(400, 'Check the review details and try again.');
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.trim().length > 500
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(body.reason)) {
    throw fail(400, 'Add a reason of 1 to 500 characters.');
  }
  if (body.createTask ? !validDate(body.dueDate) : body.dueDate !== null) {
    throw fail(400, 'Choose a valid due date when creating a follow-up task.');
  }
  if (body.action === 'restore' && (body.createTask || body.dueDate !== null)) {
    throw fail(400, 'Restoring a requirement does not create a follow-up task.');
  }
  return {
    p_request_id: body.requestId.toLowerCase(),
    p_applicant_id: body.applicantId.toLowerCase(),
    p_expected_updated_at: body.expectedUpdatedAt,
    p_item_key: body.itemKey,
    p_action: body.action,
    p_reason: body.reason.trim(),
    p_due_date: body.dueDate,
    p_create_task: body.createTask
  };
}

function publicPayload(value, applicantId) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !uuid(value.applicantId) || value.applicantId.toLowerCase() !== applicantId
    || !validTimestamp(value.updatedAt) || !Array.isArray(value.items)
    || value.items.length !== ITEM_KEYS.length) throw fail(502, 'Talent review returned invalid deferral details.');
  const seen = new Set();
  const items = value.items.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !ITEM_KEYS.includes(item.key)
      || seen.has(item.key) || typeof item.label !== 'string' || !item.label.trim()
      || item.label.length > 100 || /[\u0000-\u001f]/.test(item.label)
      || !['pending', 'complete', 'deferred'].includes(item.status)) {
      throw fail(502, 'Talent review returned invalid deferral details.');
    }
    seen.add(item.key);
    const deferral = publicDeferral(item.deferral);
    if ((item.status === 'deferred') !== Boolean(deferral)) throw fail(502, 'Talent review returned invalid deferral details.');
    return { key: item.key, label: item.label.trim(), status: item.status, deferral };
  });
  return { applicantId, updatedAt: value.updatedAt, items };
}

function databaseError(payload) {
  if (payload?.code === '42501') return fail(403, 'Only active Admin and Talent Management accounts can manage review deferrals.');
  if (['22023', '22007', '22008'].includes(payload?.code)) return fail(400, 'Check the review details and try again.');
  if (payload?.code === '40001' || (payload?.code === 'P0001'
    && payload?.message === 'This Talent application changed after it was opened.')) {
    return fail(409, 'This Talent application changed. Reload the review before choosing another action.');
  }
  if (['P0001', '23505', '23514'].includes(payload?.code)) return fail(409, 'This deferral action is no longer available. Reload the review.');
  return fail(503, 'Talent review deferrals are temporarily unavailable.');
}

async function callRpc(name, body) {
  const result = await service(`/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const payload = await result.json().catch(() => null);
  if (!result.ok) throw databaseError(payload);
  return payload;
}

async function handler(event) {
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    const result = json(405, { message: 'Method not allowed.' });
    result.headers.Allow = 'GET, POST';
    return result;
  }
  try {
    const input = event.httpMethod === 'GET' ? { p_applicant_id: queryApplicant(event) } : postInput(event);
    const userId = await actor(event);
    const payload = await callRpc(event.httpMethod === 'GET' ? 'get_talent_review_deferrals' : 'manage_talent_review_deferral', {
      p_actor_user_id: userId, ...input
    });
    return json(200, event.httpMethod === 'GET' ? publicPayload(payload, input.p_applicant_id) : publicQueue(payload));
  } catch (error) {
    const status = [400, 401, 403, 409, 413, 502, 503].includes(error.status) ? error.status : 503;
    return json(status, { message: status >= 500 ? 'Talent review deferrals are temporarily unavailable.' : error.message });
  }
}

module.exports = { handler, postInput, queryApplicant, publicPayload, POST_KEYS, ITEM_KEYS };
