'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { handler, validate } = require('../netlify/functions/talent-profile-files');

const ACTOR = '10000000-0000-4000-8000-000000000010';
const OTHER = '10000000-0000-4000-8000-000000000011';
const FILE = '20000000-0000-4000-8000-000000000010';
const REQUEST = '30000000-0000-4000-8000-000000000010';
const DOCUMENT = '40000000-0000-4000-8000-000000000010';
const BASE = 'https://upload-test.supabase.co';
const RPC = '/rest/v1/rpc/talent_self_upload';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PDF_BYTES = Buffer.from('%PDF-1.7\nSignature fixture\n%%EOF');

function prepare(overrides = {}) {
  return { action: 'prepare', requestId: REQUEST, kind: 'resume', name: 'current-resume.pdf', type: 'application/pdf', size: PDF_BYTES.length, ...overrides };
}
function event(body, overrides = {}) {
  return { httpMethod: 'POST', headers: { authorization: 'Bearer signed-in-test-token' }, body: JSON.stringify(body), ...overrides };
}
function reservation(overrides = {}) {
  return { fileId: FILE, bucket: 'soro-private-documents', path: `applicants/${ACTOR}/self-service/${FILE}/resume.pdf`, size: PDF_BYTES.length, type: 'application/pdf', kind: 'resume', documentId: null, ...overrides };
}
function install(t, respond, auth = { id: ACTOR }) {
  const priorFetch = global.fetch;
  const previous = { SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY };
  process.env.SUPABASE_URL = BASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'unit-test-service-key';
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const call = { url: String(url), pathname: new URL(url).pathname, options };
    calls.push(call);
    if (call.pathname === '/auth/v1/user') return auth instanceof Response ? auth.clone() : Response.json(auth);
    return respond(call, calls);
  };
  t.after(() => {
    global.fetch = priorFetch;
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  return calls;
}

test('upload validation rejects injected identity, document authority, and malformed format choices', () => {
  for (const field of ['actorId', 'applicantId', 'organizationId', 'path', 'storage_path', 'documentId', 'status', 'sha256']) {
    assert.throws(() => validate(prepare({ [field]: OTHER })), /Unexpected upload field/);
    assert.throws(() => validate({ action: 'complete', fileId: FILE, [field]: OTHER }), /Unexpected upload field/);
  }
  for (const action of ['finalize', 'get', '__proto__', 'toString']) assert.throws(() => validate({ action }), /Choose/);
  for (const kind of ['__proto__', 'constructor', 'template', 'application_attachment']) assert.throws(() => validate(prepare({ kind })), /Choose/);
  for (const name of ['../resume.pdf', 'folder\\resume.pdf', 'resume\u0000.pdf', 'resume\n.pdf', ' ', 'a'.repeat(181)]) assert.throws(() => validate(prepare({ name })), /Use JPG/);
  for (const size of [0, -1, 1.5, '30', 10485761, null]) assert.throws(() => validate(prepare({ size })), /Use JPG/);
  assert.throws(() => validate(prepare({ name: 'headshot.jpg' })), /extension/);
  assert.throws(() => validate(prepare({ kind: 'profile_photo', name: 'photo.png', type: 'image/png', size: 5242881 })), /Use JPG/);
  assert.throws(() => validate(prepare({ kind: 'profile_photo', name: 'photo.webp', type: 'image/webp' })), /Use JPG/);
  assert.throws(() => validate(prepare({ name: 'old.doc', type: 'application/msword' })), /Use JPG/);
  assert.throws(() => validate(prepare({ kind: 'profile_photo' })), /Use JPG/);
  assert.throws(() => validate({ action: 'complete', fileId: 'not-a-uuid' }), /valid upload/);
});

for (const [kind, name, type, size] of [
  ['profile_photo', 'portrait.JPG', 'image/jpeg', 5242880],
  ['profile_photo', 'portrait.jpeg', 'image/jpeg', 1],
  ['profile_photo', 'portrait.png', 'image/png', 5242880],
  ['resume', 'new-resume.pdf', 'application/pdf', 10485760],
  ['resume', 'new-resume.docx', DOCX, 10485760]
]) test(`upload validation accepts the supported ${name} format and its size boundary`, () => {
  assert.equal(validate(prepare({ kind, name, type, size })).type, type);
});

test('missing authentication prevents all backend calls', async t => {
  const calls = install(t, () => { throw new Error('Unexpected backend request'); });
  const result = await handler(event(prepare(), { headers: {} }));
  assert.equal(result.statusCode, 401);
  assert.equal(calls.length, 0);
});

for (const [label, auth] of [
  ['expired session', Response.json({ message: 'expired' }, { status: 401 })],
  ['malformed verified identity', { id: 'not-a-uuid' }]
]) test(`${label} cannot reserve or sign an upload`, async t => {
  const calls = install(t, () => { throw new Error('Unexpected backend request'); }, auth);
  assert.equal((await handler(event(prepare()))).statusCode, 401);
  assert.equal(calls.length, 1);
});

test('unsupported methods, query scope, encoded bodies, and oversized requests fail closed', async t => {
  const calls = install(t, () => { throw new Error('Unexpected backend request'); });
  assert.equal((await handler(event(prepare(), { httpMethod: 'GET' }))).statusCode, 405);
  assert.equal(calls.length, 0);
  for (const overrides of [
    { queryStringParameters: { applicantId: OTHER } },
    { isBase64Encoded: true },
    { body: '{broken json' },
    { body: 'a'.repeat(4001) }
  ]) assert.equal((await handler(event(prepare(), overrides))).statusCode, 400);
  assert.ok(calls.every(call => call.pathname === '/auth/v1/user'));
});

test('prepare uses the verified actor and signs only the RPC-reserved immutable private path', async t => {
  const f = reservation();
  const signedPath = `/object/upload/sign/${f.bucket}/${f.path}?token=unit-test-upload`;
  const calls = install(t, call => {
    if (call.pathname === RPC) {
      assert.deepEqual(JSON.parse(call.options.body), { p_actor_user_id: ACTOR, p_body: prepare() });
      return Response.json(f);
    }
    assert.equal(call.pathname, `/storage/v1/object/upload/sign/${f.bucket}/${f.path}`);
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['x-upsert'], 'false');
    return Response.json({ url: signedPath });
  });
  const result = await handler(event(prepare()));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { fileId: FILE, url: `${BASE}/storage/v1${signedPath}` });
  assert.equal(calls[0].options.headers.Authorization, 'Bearer signed-in-test-token');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal(result.headers.Vary, 'Authorization');
  assert.equal(calls.length, 3);
});

test('injected actor scope is rejected before any reservation RPC', async t => {
  const calls = install(t, () => { throw new Error('Unexpected backend request'); });
  assert.equal((await handler(event(prepare({ actorId: OTHER })))).statusCode, 400);
  assert.equal(calls.length, 1);
});

test('another Talent account cannot complete an existing upload when the ownership RPC rejects it', async t => {
  const calls = install(t, call => {
    assert.equal(call.pathname, RPC);
    assert.deepEqual(JSON.parse(call.options.body), { p_actor_user_id: OTHER, p_body: { action: 'get', fileId: FILE } });
    return Response.json({ code: '42501', message: 'Own upload required' }, { status: 403 });
  }, { id: OTHER });
  const result = await handler(event({ action: 'complete', fileId: FILE }));
  assert.equal(result.statusCode, 403);
  assert.equal(calls.length, 2);
});

for (const [label, code, expectedStatus] of [
  ['inactive or non-Talent account', '42501', 403],
  ['changed request replay', '23505', 409],
  ['hourly reservation limit', 'P0001', 429],
  ['expired reservation', '22023', 400]
]) test(`${label} cannot obtain a signed upload URL`, async t => {
  const calls = install(t, call => {
    assert.equal(call.pathname, RPC);
    return Response.json({ code }, { status: 400 });
  });
  assert.equal((await handler(event(prepare()))).statusCode, expectedStatus);
  assert.equal(calls.length, 2);
});

test('a signing response from a foreign origin cannot reach the browser', async t => {
  install(t, call => call.pathname === RPC ? Response.json(reservation()) : Response.json({ url: 'https://foreign.example/storage/v1/object/upload/sign/file?token=x' }));
  const result = await handler(event(prepare()));
  assert.equal(result.statusCode, 503);
  assert.doesNotMatch(result.body, /foreign\.example|token=x/);
});

for (const [label, changed] of [
  ['wrong bucket', { bucket: 'public' }],
  ['unsafe path', { path: 'applicants/../private-file' }],
  ['oversized image metadata', { kind: 'profile_photo', type: 'image/png', size: 5242881 }],
  ['unsupported MIME metadata', { type: 'text/html' }]
]) test(`${label} in reservation metadata cannot be signed`, async t => {
  const calls = install(t, call => {
    assert.equal(call.pathname, RPC);
    return Response.json(reservation(changed));
  });
  assert.equal((await handler(event(prepare()))).statusCode, 503);
  assert.equal(calls.length, 2);
});

const SIGNATURE_FIXTURES = [
  ['PDF', 'resume', 'application/pdf', PDF_BYTES],
  ['JPEG', 'profile_photo', 'image/jpeg', Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70])],
  ['PNG', 'profile_photo', 'image/png', Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])],
  ['DOCX', 'resume', DOCX, Buffer.from('PK\x03\x04[Content_Types].xml word/document.xml')]
];
for (const [label, kind, type, bytes] of SIGNATURE_FIXTURES) test(`${label} completion checks stored bytes and supplies a server-derived SHA-256`, async t => {
  const f = reservation({ kind, type, size: bytes.length });
  let finalized = false;
  const calls = install(t, call => {
    if (call.pathname === RPC) {
      const { p_actor_user_id, p_body } = JSON.parse(call.options.body);
      assert.equal(p_actor_user_id, ACTOR);
      if (p_body.action === 'get') return Response.json(f);
      assert.deepEqual(p_body, { action: 'finalize', fileId: FILE, sha256: createHash('sha256').update(bytes).digest('hex'), type, size: bytes.length });
      finalized = true;
      return Response.json({ ...f, documentId: DOCUMENT });
    }
    assert.equal(call.pathname, `/storage/v1/object/${f.bucket}/${f.path}`);
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  });
  const result = await handler(event({ action: 'complete', fileId: FILE }));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { fileId: FILE, documentId: DOCUMENT });
  assert.equal(finalized, true);
  assert.equal(calls.length, 4);
});

for (const [label, bytes, size] of [
  ['HTML claiming PDF', Buffer.from('<html>not a PDF</html>'), 22],
  ['PNG claiming PDF', SIGNATURE_FIXTURES[2][3], SIGNATURE_FIXTURES[2][3].length],
  ['truncated upload', PDF_BYTES.subarray(0, PDF_BYTES.length - 1), PDF_BYTES.length],
  ['oversized upload', Buffer.concat([PDF_BYTES, Buffer.from('extra')]), PDF_BYTES.length]
]) test(`${label} never reaches finalization`, async t => {
  const f = reservation({ size });
  const calls = install(t, call => {
    if (call.pathname === RPC) {
      assert.equal(JSON.parse(call.options.body).p_body.action, 'get');
      return Response.json(f);
    }
    return new Response(bytes);
  });
  const result = await handler(event({ action: 'complete', fileId: FILE }));
  assert.equal(result.statusCode, 400);
  assert.equal(calls.length, 3);
});

test('revocation after reading the object prevents finalization and successful attachment', async t => {
  const calls = install(t, call => {
    if (call.pathname === RPC) {
      const body = JSON.parse(call.options.body).p_body;
      return body.action === 'get' ? Response.json(reservation()) : Response.json({ code: '42501' }, { status: 403 });
    }
    return new Response(PDF_BYTES);
  });
  assert.equal((await handler(event({ action: 'complete', fileId: FILE }))).statusCode, 403);
  assert.equal(calls.length, 4);
});

test('repeated completion returns the existing document without re-reading storage or finalizing again', async t => {
  let finalized = false;
  const calls = install(t, call => {
    if (call.pathname === RPC) {
      const body = JSON.parse(call.options.body).p_body;
      if (body.action === 'finalize') finalized = true;
      return Response.json(reservation({ documentId: finalized ? DOCUMENT : null }));
    }
    return new Response(PDF_BYTES);
  });
  const first = await handler(event({ action: 'complete', fileId: FILE }));
  const second = await handler(event({ action: 'complete', fileId: FILE }));
  assert.equal(first.statusCode, 200);
  assert.deepEqual(JSON.parse(second.body), JSON.parse(first.body));
  assert.equal(calls.filter(call => call.pathname === RPC && JSON.parse(call.options.body).p_body.action === 'finalize').length, 1);
  assert.equal(calls.filter(call => call.pathname.startsWith('/storage/')).length, 1);
});

test('replaying a completed preparation cannot mint another signed upload URL', async t => {
  const calls = install(t, call => {
    assert.equal(call.pathname, RPC);
    return Response.json(reservation({ documentId: DOCUMENT }));
  });
  const result = await handler(event(prepare()));
  assert.equal(result.statusCode, 200);
  assert.deepEqual(JSON.parse(result.body), { fileId: FILE, complete: true });
  assert.equal(calls.length, 2);
});
