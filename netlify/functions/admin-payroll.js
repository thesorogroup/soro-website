const crypto = require('node:crypto');

const configuredUrl = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = /^https:\/\/[^/]+\.supabase\.co\/?$/.test(configuredUrl)
  ? configuredUrl.replace(/\/$/, '')
  : '';
const SERVICE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '').trim();

const MAX_RUNS = 100;
const MAX_ITEMS_PER_RUN = 1000;
const MAX_EXPORT_ROWS = 1000;
const MAX_REQUEST_BYTES = 16 * 1024;

const EMPLOYEE_STATUSES = new Set(['draft', 'ready', 'approved', 'exported', 'reconciled', 'cancelled']);
const TALENT_STATUSES = new Set(['draft', 'ready', 'approved', 'exported', 'released', 'cancelled']);
const EMPLOYEE_TRANSITIONS = new Set(['ready', 'approve', 'reconcile', 'cancel']);
const TALENT_TRANSITIONS = new Set(['ready', 'approve', 'release', 'cancel']);
const VERIFICATION_STATUSES = new Set(['verified', 'needs_review']);
const EMPLOYEE_WISE_ROUTE = 'wise_contractor';

const ACTION_KEYS = Object.freeze({
  create_employee_run: Object.freeze(['action', 'requestId', 'periodStart', 'periodEnd', 'payDate', 'currency']),
  update_employee_item: Object.freeze(['action', 'requestId', 'runId', 'itemId', 'amount', 'note', 'included', 'payoutRecipientEmail']),
  transition_employee_run: Object.freeze(['action', 'requestId', 'runId', 'transition', 'reference', 'note']),
  export_employee_run: Object.freeze(['action', 'requestId', 'runId']),
  create_talent_run: Object.freeze(['action', 'requestId', 'periodStart', 'periodEnd', 'payDate', 'currency']),
  update_talent_item: Object.freeze(['action', 'requestId', 'runId', 'itemId', 'amount', 'note', 'included', 'recipientEmail']),
  verify_talent_item: Object.freeze(['action', 'requestId', 'runId', 'itemId', 'verificationStatus', 'note']),
  transition_talent_run: Object.freeze(['action', 'requestId', 'runId', 'transition', 'reference', 'note']),
  export_talent_run: Object.freeze(['action', 'requestId', 'runId'])
});

function responseHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    Vary: 'Authorization',
    ...extra
  };
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: responseHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      ...extraHeaders
    }),
    body: JSON.stringify(body)
  };
}

function csvResponse(body, fileName) {
  return {
    statusCode: 200,
    headers: responseHeaders({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'X-Download-Options': 'noopen'
    }),
    body
  };
}

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function bearerToken(event) {
  const header = event.headers?.authorization || event.headers?.Authorization || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1]?.trim() || '';
}

function validUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || '').trim());
}

function validDate(value) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return false;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === normalized;
}

function validEmail(value) {
  const normalized = String(value || '').trim();
  return normalized.length <= 254
    && !/[\r\n]/.test(normalized)
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
}

function hasExactKeys(value, expectedKeys) {
  const keys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function parseBody(event) {
  if (Buffer.byteLength(event.body || '', 'utf8') > MAX_REQUEST_BYTES) {
    throw httpError(413, 'request_too_large', 'The payroll request is too large.');
  }
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    throw httpError(400, 'invalid_request', 'The payroll request could not be read.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_request', 'The payroll request must be a JSON object.');
  }
  return body;
}

function rejectQueryScope(event) {
  const query = event.queryStringParameters || {};
  const multiValueQuery = event.multiValueQueryStringParameters || {};
  const rawQuery = String(event.rawQueryString || '').trim();
  if (Object.keys(query).length || Object.keys(multiValueQuery).length || rawQuery) {
    throw httpError(400, 'unsupported_scope', 'Payroll scope is determined by the signed-in account.');
  }
}

function rejectUnexpectedGetScope(event) {
  rejectQueryScope(event);
  if (String(event.body || '').trim()) {
    throw httpError(400, 'unsupported_scope', 'Payroll scope is determined by the signed-in account.');
  }
}

function serviceHeaders(extra = {}) {
  const headers = { apikey: SERVICE_KEY, ...extra };
  if (SERVICE_KEY && !SERVICE_KEY.startsWith('sb_secret_')) headers.Authorization = `Bearer ${SERVICE_KEY}`;
  return headers;
}

async function authenticatedUser(event) {
  const token = bearerToken(event);
  if (!token) throw httpError(401, 'authentication_required', 'Sign in to use Payroll & Payouts.');
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw httpError(503, 'service_unavailable', 'Payroll & Payouts is not configured yet.');
  }

  const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw httpError(401, 'authentication_required', 'Sign in again to use Payroll & Payouts.');
    }
    throw httpError(503, 'service_unavailable', 'Payroll & Payouts is temporarily unavailable.');
  }

  const user = await response.json().catch(() => null);
  if (!validUuid(user?.id)) throw httpError(401, 'authentication_required', 'Sign in again to use Payroll & Payouts.');
  return user;
}

async function responseJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function rpcError(status, payload) {
  const databaseCode = String(payload?.code || '');
  const databaseMessage = String(payload?.message || '');
  if (databaseCode === '42501') {
    return httpError(403, 'payroll_forbidden', 'Your account does not have access to this payroll action.');
  }
  if (databaseCode === '23505') {
    return httpError(409, 'payroll_duplicate', 'This payroll action has already been recorded.');
  }
  if (
    databaseCode === 'P0001'
    && databaseMessage === 'No active Wise-contractor employee profiles are eligible for this payroll period.'
  ) {
    return httpError(
      409,
      'no_eligible_employee_payroll',
      'No active Philippines contractor employees are eligible for this period. In Employees, confirm the hire date and set Payment route to Philippines contractor — Wise, then try again.'
    );
  }
  if (
    databaseCode === 'P0001'
    && databaseMessage === 'No current Talent placements are eligible for this payout period.'
  ) {
    return httpError(
      409,
      'no_eligible_talent_payouts',
      'No current Talent placements are eligible for this period. Confirm the placement dates and payout setup, then try again.'
    );
  }
  if (databaseCode === '23514' || databaseCode === 'P0001') {
    return httpError(409, 'payroll_conflict', 'This payroll action is not available in the current state.');
  }
  if (databaseCode === '22023') {
    return httpError(400, 'invalid_request', 'Check the payroll details and try again.');
  }
  if (databaseCode === 'PGRST202' || status === 404) {
    return httpError(503, 'service_unavailable', 'Payroll & Payouts is not configured yet.');
  }
  const safeStatus = status === 401 || status === 403 ? 503 : 500;
  return httpError(safeStatus, 'payroll_service_error', 'Payroll & Payouts is temporarily unavailable. Please try again.');
}

async function callRpc(name, body) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: serviceHeaders({
      Accept: 'application/json',
      'Content-Type': 'application/json'
    }),
    body: JSON.stringify(body)
  });
  const payload = await responseJson(response);
  if (!response.ok) throw rpcError(response.status, payload);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return payload;
}

function nullableText(value, maximum) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\u0000]/.test(normalized)) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return normalized;
}

function requiredText(value, maximum) {
  const normalized = nullableText(value, maximum);
  if (!normalized) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  return normalized;
}

function requiredUuid(value) {
  if (!validUuid(value)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  return String(value).trim().toLowerCase();
}

function nullableUuid(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredUuid(value);
}

function requiredDate(value) {
  if (!validDate(value)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  return String(value).trim();
}

function requiredTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return value;
}

function nullableTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  return requiredTimestamp(value);
}

function requiredBoolean(value) {
  if (typeof value !== 'boolean') throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  return value;
}

function requiredInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return value;
}

function nullableMoney(value, allowZero = true) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 999999999999.99) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  if (!allowZero && value === 0) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-7) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return value;
}

function requiredMoney(value, allowZero = true) {
  const amount = nullableMoney(value, allowZero);
  if (amount === null) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  return amount;
}

function requiredCurrency(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  return normalized;
}

function nullableSha256(value) {
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  return normalized;
}

function publicEmployeeItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  const item = {
    itemId: requiredUuid(value.itemId),
    employeeUserId: requiredUuid(value.employeeUserId),
    employeeName: requiredText(value.employeeName, 180),
    employeeEmail: requiredText(value.employeeEmail, 254),
    employeeRole: requiredText(value.employeeRole, 80),
    hireDate: requiredDate(value.hireDate),
    paymentRoute: requiredText(value.paymentRoute, 40),
    payoutRecipientEmail: nullableText(value.payoutRecipientEmail, 254),
    included: requiredBoolean(value.included),
    amount: nullableMoney(value.amount),
    note: nullableText(value.note, 500),
    exceptionStatus: requiredText(value.exceptionStatus, 80),
    exceptionNote: nullableText(value.exceptionNote, 500),
    updatedAt: requiredTimestamp(value.updatedAt)
  };
  if (item.paymentRoute !== EMPLOYEE_WISE_ROUTE
    || (item.payoutRecipientEmail !== null && !validEmail(item.payoutRecipientEmail))
    || !['clear', 'needs_review'].includes(item.exceptionStatus)) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return item;
}

function publicTalentItem(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  const item = {
    itemId: requiredUuid(value.itemId),
    applicantId: requiredUuid(value.applicantId),
    placementId: requiredUuid(value.placementId),
    talentName: requiredText(value.talentName, 180),
    recipientEmail: nullableText(value.recipientEmail, 254),
    clientName: requiredText(value.clientName, 180),
    rateType: nullableText(value.rateType, 80),
    rateAmount: nullableMoney(value.rateAmount),
    paymentReference: requiredText(value.paymentReference, 140),
    included: requiredBoolean(value.included),
    amount: nullableMoney(value.amount),
    note: nullableText(value.note, 500),
    verificationStatus: requiredText(value.verificationStatus, 80),
    verificationNote: nullableText(value.verificationNote, 500),
    verifiedBy: nullableText(value.verifiedBy, 180),
    verifiedAt: nullableTimestamp(value.verifiedAt),
    exceptionStatus: requiredText(value.exceptionStatus, 80),
    exceptionNote: nullableText(value.exceptionNote, 500),
    updatedAt: requiredTimestamp(value.updatedAt)
  };
  if (!VERIFICATION_STATUSES.has(item.verificationStatus) || !['clear', 'needs_review'].includes(item.exceptionStatus)) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return item;
}

function publicRun(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.items)) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  if (value.items.length > MAX_ITEMS_PER_RUN) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  const statuses = kind === 'employee' ? EMPLOYEE_STATUSES : TALENT_STATUSES;
  if (!statuses.has(value.status)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  const run = {
    runId: requiredUuid(value.runId),
    periodStart: requiredDate(value.periodStart),
    periodEnd: requiredDate(value.periodEnd),
    payDate: requiredDate(value.payDate),
    currency: requiredCurrency(value.currency),
    status: value.status,
    totalAmount: requiredMoney(value.totalAmount),
    itemCount: requiredInteger(value.itemCount),
    exceptionCount: requiredInteger(value.exceptionCount),
    createdBy: requiredText(value.createdBy, 180),
    createdAt: requiredTimestamp(value.createdAt),
    approvedBy: nullableText(value.approvedBy, 180),
    approvedAt: nullableTimestamp(value.approvedAt),
    exportedBy: nullableText(value.exportedBy, 180),
    exportedAt: nullableTimestamp(value.exportedAt),
    exportFileName: nullableText(value.exportFileName, 180),
    exportSha256: nullableSha256(value.exportSha256),
    externalReference: nullableText(value.externalReference, 240),
    notes: nullableText(value.notes, 1000),
    updatedAt: requiredTimestamp(value.updatedAt),
    canEdit: requiredBoolean(value.canEdit),
    canApprove: requiredBoolean(value.canApprove),
    canExport: requiredBoolean(value.canExport),
    canCancel: requiredBoolean(value.canCancel),
    items: value.items.map(kind === 'employee' ? publicEmployeeItem : publicTalentItem)
  };
  const includedItems = run.items.filter(item => item.included).length;
  if (run.periodEnd < run.periodStart || run.itemCount !== includedItems || run.exceptionCount > run.itemCount) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  if (kind === 'employee') {
    run.reconciledBy = nullableText(value.reconciledBy, 180);
    run.reconciledAt = nullableTimestamp(value.reconciledAt);
    run.canReconcile = requiredBoolean(value.canReconcile);
  } else {
    run.releasedBy = nullableText(value.releasedBy, 180);
    run.releasedAt = nullableTimestamp(value.releasedAt);
    run.canVerify = requiredBoolean(value.canVerify);
    run.canRelease = requiredBoolean(value.canRelease);
  }
  return run;
}

function publicSection(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.runs) || value.runs.length > MAX_RUNS) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return { runs: value.runs.map(run => publicRun(run, kind)) };
}

function publicPayload(payload) {
  const viewerRole = ['admin', 'talent_management'].includes(payload.viewerRole) ? payload.viewerRole : null;
  if (!viewerRole) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  if (viewerRole === 'admin' && !payload.employeePayroll) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  if (viewerRole === 'talent_management' && payload.employeePayroll !== null) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid response.');
  }
  return {
    generatedAt: requiredTimestamp(payload.generatedAt),
    viewerRole,
    employeePayroll: viewerRole === 'admin' ? publicSection(payload.employeePayroll, 'employee') : null,
    talentPayouts: publicSection(payload.talentPayouts, 'talent')
  };
}

function inputUuid(value, label) {
  const normalized = String(value || '').trim();
  if (!validUuid(normalized)) throw httpError(400, 'invalid_request_id', `A valid ${label} is required.`);
  return normalized.toLowerCase();
}

function inputDate(value, label) {
  if (!validDate(value)) throw httpError(400, 'invalid_dates', `Choose a valid ${label}.`);
  return String(value).trim();
}

function inputCurrency(value) {
  const normalized = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalized)) throw httpError(400, 'invalid_currency', 'Choose a valid three-letter currency.');
  return normalized;
}

function inputNullableText(value, maximum, label) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw httpError(400, 'invalid_request', `${label} must be text or blank.`);
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length > maximum || /[\u0000]/.test(normalized)) {
    throw httpError(400, 'invalid_request', `${label} is too long.`);
  }
  return normalized;
}

function inputAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(value.trim())) {
    throw httpError(400, 'invalid_amount', 'Enter a positive amount with no more than two decimal places.');
  }
  const amount = Number(value.trim());
  if (!Number.isFinite(amount) || amount <= 0 || amount > 999999999999.99) {
    throw httpError(400, 'invalid_amount', 'Enter a positive amount with no more than two decimal places.');
  }
  return amount;
}

function inputNullableEmail(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !validEmail(value)) throw httpError(400, 'invalid_email', 'Enter a valid recipient email or leave it blank.');
  return value.trim();
}

function buildCreateBody(body) {
  const periodStart = inputDate(body.periodStart, 'period start date');
  const periodEnd = inputDate(body.periodEnd, 'period end date');
  const payDate = inputDate(body.payDate, 'pay date');
  if (periodEnd < periodStart) throw httpError(400, 'invalid_dates', 'Period end must be on or after period start.');
  return {
    p_request_id: inputUuid(body.requestId, 'request id'),
    p_period_start: periodStart,
    p_period_end: periodEnd,
    p_pay_date: payDate,
    p_currency: inputCurrency(body.currency)
  };
}

function buildUpdateBody(body, kind) {
  if (typeof body.included !== 'boolean') throw httpError(400, 'invalid_request', 'Included must be true or false.');
  const result = {
    p_request_id: inputUuid(body.requestId, 'request id'),
    p_run_id: inputUuid(body.runId, 'run id'),
    p_item_id: inputUuid(body.itemId, 'item id'),
    p_amount: inputAmount(body.amount),
    p_note: inputNullableText(body.note, 500, 'Note'),
    p_included: body.included
  };
  if (kind === 'employee') result.p_payout_recipient_email = inputNullableEmail(body.payoutRecipientEmail);
  if (kind === 'talent') result.p_recipient_email = inputNullableEmail(body.recipientEmail);
  return result;
}

function buildVerifyBody(body) {
  const verificationStatus = String(body.verificationStatus || '').trim().toLowerCase();
  if (!VERIFICATION_STATUSES.has(verificationStatus)) {
    throw httpError(400, 'invalid_verification_status', 'Choose Verified or Needs review.');
  }
  return {
    p_request_id: inputUuid(body.requestId, 'request id'),
    p_run_id: inputUuid(body.runId, 'run id'),
    p_item_id: inputUuid(body.itemId, 'item id'),
    p_verification_status: verificationStatus,
    p_note: inputNullableText(body.note, 500, 'Verification note')
  };
}

function buildTransitionBody(body, kind) {
  const transition = String(body.transition || '').trim().toLowerCase();
  const allowed = kind === 'employee' ? EMPLOYEE_TRANSITIONS : TALENT_TRANSITIONS;
  if (!allowed.has(transition)) throw httpError(400, 'unsupported_transition', 'Choose an available payroll transition.');
  const reference = inputNullableText(body.reference, 180, 'Reference');
  const note = inputNullableText(body.note, 500, 'Note');
  const finalAction = kind === 'employee' ? 'reconcile' : 'release';
  if (transition === finalAction && !reference) {
    throw httpError(400, 'reference_required', 'Add the external payment reference before completing this action.');
  }
  if (transition !== finalAction && reference) {
    throw httpError(400, 'unsupported_reference', 'An external reference is accepted only when completing payment.');
  }
  return {
    p_request_id: inputUuid(body.requestId, 'request id'),
    p_run_id: inputUuid(body.runId, 'run id'),
    p_action: transition,
    p_reference: reference,
    p_note: note,
    p_export_file_name: null,
    p_export_sha256: null
  };
}

function csvCell(value) {
  let normalized = value === null || value === undefined ? '' : String(value);
  normalized = normalized.replace(/[\r\n]+/g, ' ').replace(/\u0000/g, '').trim();
  if (/^[\t ]*[=+\-@]/.test(normalized)) normalized = `'${normalized}`;
  return `"${normalized.replace(/"/g, '""')}"`;
}

function csvMoney(value) {
  return Number(value).toFixed(2);
}

function exportSnapshot(payload, kind) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.rows) || payload.rows.length > MAX_EXPORT_ROWS) {
    throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid export.');
  }
  const allowedStatuses = kind === 'employee'
    ? new Set(['approved', 'exported', 'reconciled'])
    : new Set(['approved', 'exported', 'released']);
  if (!allowedStatuses.has(payload.status)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid export.');
  const currency = requiredCurrency(payload.currency);
  const common = {
    runId: requiredUuid(payload.runId),
    periodStart: requiredDate(payload.periodStart),
    periodEnd: requiredDate(payload.periodEnd),
    payDate: requiredDate(payload.payDate),
    currency,
    status: payload.status
  };
  if (common.periodEnd < common.periodStart) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid export.');
  const rows = payload.rows.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid export.');
    if (kind === 'employee') {
      if (value.paymentRoute !== EMPLOYEE_WISE_ROUTE || !validEmail(value.payoutRecipientEmail)) {
        throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid export.');
      }
      return {
        itemId: requiredUuid(value.itemId),
        name: requiredText(value.employeeName, 180),
        email: String(value.payoutRecipientEmail).trim(),
        amount: requiredMoney(value.amount, false),
        currency,
        reference: requiredText(value.reference, 140),
        note: nullableText(value.note, 500)
      };
    }
    if (!validEmail(value.recipientEmail) || requiredCurrency(value.currency) !== currency) {
      throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid export.');
    }
    return {
      itemId: requiredUuid(value.itemId),
      name: requiredText(value.talentName, 180),
      email: String(value.recipientEmail).trim(),
      amount: requiredMoney(value.amount, false),
      currency,
      reference: requiredText(value.reference, 140),
      note: null
    };
  });
  rows.sort((left, right) => left.name.localeCompare(right.name, 'en', { sensitivity: 'base' }) || left.itemId.localeCompare(right.itemId));
  return { ...common, rows };
}

function buildCsv(snapshot, kind) {
  const headers = kind === 'employee'
    ? ['Staff name', 'Wise recipient email', 'Amount', 'Currency', 'Reference', 'Internal note']
    : ['Talent name', 'Recipient email', 'Amount', 'Currency', 'Reference'];
  const rows = snapshot.rows.map(row => {
    const values = [row.name, row.email, csvMoney(row.amount), row.currency, row.reference];
    if (kind === 'employee') values.push(row.note);
    return values.map(csvCell).join(',');
  });
  return `\uFEFF${[headers.map(csvCell).join(','), ...rows].join('\r\n')}\r\n`;
}

function exportFileName(snapshot, kind) {
  const label = kind === 'employee' ? 'staff-wise-preparation' : 'talent-payouts';
  return `soro-${label}-${snapshot.periodStart}-to-${snapshot.periodEnd}-${snapshot.currency.toLowerCase()}.csv`;
}

async function getWorkspace(event) {
  rejectUnexpectedGetScope(event);
  const user = await authenticatedUser(event);
  const payload = await callRpc('get_admin_payroll_workspace', { p_actor_user_id: user.id });
  return json(200, publicPayload(payload));
}

async function exportRun(event, user, body, kind) {
  const requestId = inputUuid(body.requestId, 'request id');
  const runId = inputUuid(body.runId, 'run id');
  const exportRpc = kind === 'employee' ? 'get_employee_payroll_export' : 'get_talent_payout_export';
  const transitionRpc = kind === 'employee' ? 'transition_employee_payroll_run' : 'transition_talent_payout_run';
  const snapshot = exportSnapshot(await callRpc(exportRpc, {
    p_actor_user_id: user.id,
    p_run_id: runId
  }), kind);
  if (snapshot.runId !== runId) throw httpError(502, 'payroll_service_error', 'Payroll & Payouts returned an invalid export.');
  const fileName = exportFileName(snapshot, kind);
  const csv = buildCsv(snapshot, kind);
  const sha256 = crypto.createHash('sha256').update(csv, 'utf8').digest('hex');
  const workspace = await callRpc(transitionRpc, {
    p_actor_user_id: user.id,
    p_request_id: requestId,
    p_run_id: runId,
    p_action: 'export',
    p_reference: null,
    p_note: null,
    p_export_file_name: fileName,
    p_export_sha256: sha256
  });
  publicPayload(workspace);
  return csvResponse(csv, fileName);
}

async function postAction(event) {
  rejectQueryScope(event);
  const body = parseBody(event);
  const action = String(body.action || '').trim().toLowerCase();
  const expectedKeys = ACTION_KEYS[action];
  if (!expectedKeys) throw httpError(400, 'unsupported_action', 'Choose a supported payroll action.');
  if (!hasExactKeys(body, expectedKeys)) {
    throw httpError(400, 'unsupported_scope', 'Only the fields required for this payroll action are accepted.');
  }

  let rpcName;
  let rpcBody;
  if (action === 'create_employee_run' || action === 'create_talent_run') {
    rpcName = action === 'create_employee_run' ? 'create_employee_payroll_run' : 'create_talent_payout_run';
    rpcBody = buildCreateBody(body);
  } else if (action === 'update_employee_item' || action === 'update_talent_item') {
    const kind = action === 'update_employee_item' ? 'employee' : 'talent';
    rpcName = kind === 'employee' ? 'update_employee_payroll_item' : 'update_talent_payout_item';
    rpcBody = buildUpdateBody(body, kind);
  } else if (action === 'verify_talent_item') {
    rpcName = 'verify_talent_payout_item';
    rpcBody = buildVerifyBody(body);
  } else if (action === 'transition_employee_run' || action === 'transition_talent_run') {
    const kind = action === 'transition_employee_run' ? 'employee' : 'talent';
    rpcName = kind === 'employee' ? 'transition_employee_payroll_run' : 'transition_talent_payout_run';
    rpcBody = buildTransitionBody(body, kind);
  }

  const user = await authenticatedUser(event);
  if (action === 'export_employee_run') return exportRun(event, user, body, 'employee');
  if (action === 'export_talent_run') return exportRun(event, user, body, 'talent');
  const payload = await callRpc(rpcName, { p_actor_user_id: user.id, ...rpcBody });
  return json(200, publicPayload(payload));
}

async function handler(event) {
  if (!['GET', 'POST'].includes(event.httpMethod)) {
    return json(405, { code: 'method_not_allowed', message: 'Method not allowed.' }, { Allow: 'GET, POST' });
  }
  try {
    return event.httpMethod === 'GET' ? await getWorkspace(event) : await postAction(event);
  } catch (error) {
    console.error('Payroll operation failed.', {
      method: event.httpMethod,
      status: error.status,
      code: error.code,
      message: error.message
    });
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 600 ? error.status : 500;
    return json(status, {
      code: error.code || 'payroll_service_error',
      message: status >= 500 && error.code !== 'service_unavailable'
        ? 'Payroll & Payouts is temporarily unavailable. Please try again.'
        : error.message
    });
  }
}

exports.handler = handler;
exports.ACTION_KEYS = ACTION_KEYS;
exports.EMPLOYEE_TRANSITIONS = EMPLOYEE_TRANSITIONS;
exports.TALENT_TRANSITIONS = TALENT_TRANSITIONS;
exports.VERIFICATION_STATUSES = VERIFICATION_STATUSES;
exports.buildCsv = buildCsv;
exports.csvCell = csvCell;
exports.exportFileName = exportFileName;
exports.exportSnapshot = exportSnapshot;
exports.hasExactKeys = hasExactKeys;
exports.inputAmount = inputAmount;
exports.publicPayload = publicPayload;
exports.validDate = validDate;
exports.validUuid = validUuid;
