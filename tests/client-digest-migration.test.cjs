const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const migrationDirectory = path.join(root, 'supabase', 'migrations');
const repair = fs.readFileSync(path.join(migrationDirectory, '20260907_043_client_pipeline_digest_schema.sql'), 'utf8');
const migrationFiles = fs.readdirSync(migrationDirectory).filter((name) => name.endsWith('.sql')).sort();
const functions = new Map();
for (const name of migrationFiles) {
  const sql = fs.readFileSync(path.join(migrationDirectory, name), 'utf8');
  for (const match of sql.matchAll(/create or replace function\s+((?:public|private)\.[a-z_]+)\s*\([\s\S]*?\$\$;/gi)) {
    functions.set(match[1], match[0]);
  }
}
const pipeline = functions.get('public.change_client_pipeline');
const originalFingerprint = /\$fingerprint\$([\s\S]*?)\$fingerprint\$/.exec(repair)[1].replace(/\r\n/g, '\n');
const fixedFingerprint = originalFingerprint.replace('    digest(', '    extensions.digest(');

test('the forward repair matches the failing deployed fingerprint exactly and changes only its function qualification', () => {
  assert.match(pipeline, /security definer\s+set search_path = pg_catalog, public, private\s+as/i);
  const normalizedPipeline = pipeline.replace(/\r\n/g, '\n');
  assert.ok(normalizedPipeline.includes(originalFingerprint));
  assert.equal([...normalizedPipeline.matchAll(/digest\(/g)].length, 1);
  const fixed = normalizedPipeline.replace('    digest(', '    extensions.digest(');
  assert.ok(fixed.includes(fixedFingerprint));
  assert.equal(fixed.replace('    extensions.digest(', '    digest('), normalizedPipeline);
  assert.match(fixed, /extensions\.digest\(\s+convert_to\(concat_ws\(/);
  assert.match(fixed, /private\.client_pipeline_actor\(p_actor_user_id\)/);
  assert.match(fixed, /request_fingerprint is distinct from v_fingerprint/);
});

test('migration 043 fails closed on missing prerequisites or an unexpected function body', () => {
  assert.match(repair, /to_regprocedure\(\s*'public\.change_client_pipeline\(uuid,uuid,text,timestamptz,uuid,uuid,jsonb\)'/);
  assert.match(repair, /to_regprocedure\('extensions\.digest\(bytea,text\)'\)/);
  assert.match(repair, /v_function_oid is null[\s\S]*?raise exception/);
  assert.match(repair, /dependency\.objid = v_digest_oid/);
  assert.match(repair, /dependency\.deptype = 'e'[\s\S]*?extension\.extname = 'pgcrypto'/);
  assert.match(repair, /v_before_metadata ->> 'prosecdef' <> 'true'/);
  assert.match(repair, /v_original_fingerprint constant text := pg_catalog\.replace\(\$fingerprint\$[\s\S]*?\$fingerprint\$, E'\\r\\n', E'\\n'\)/);
  assert.match(repair, /strpos\(pg_catalog\.replace\(v_source, E'\\r\\n', E'\\n'\), v_original_fingerprint\)/);
  assert.match(repair, /raise exception 'Migration 043 found an unrecognized Client pipeline fingerprint/);
  assert.doesNotMatch(repair, /create extension|alter extension|drop function|update\s+pg_catalog\.pg_proc/i);
});

test('migration 043 retains the live security settings, owner, grants and complete workflow, and supports reapplication', () => {
  assert.match(repair, /pg_catalog\.pg_get_functiondef\(routine\.oid\)/);
  assert.match(repair, /execute pg_catalog\.replace\(v_definition, '    digest\(', '    extensions\.digest\('\)/);
  assert.match(repair, /\(v_after_metadata - 'prosrc'\) is distinct from \(v_before_metadata - 'prosrc'\)/);
  assert.match(repair, /v_after_source is distinct from v_expected_source/);
  assert.match(repair, /elsif[\s\S]*?v_fixed_fingerprint[\s\S]*?v_expected_source := v_source;/);
  assert.match(repair, /\bbegin;[\s\S]*\bcommit;\s*$/i);
  assert.doesNotMatch(repair, /\bgrant\s+execute|\brevoke\s+all|\balter\s+function|\bset\s+search_path/i);
});

test('no other current Client RPC has a bare digest call outside an extensions-aware search path', () => {
  const unresolved = [];
  for (const [name, definition] of functions) {
    if (!name.includes('client')) continue;
    const effective = name === 'public.change_client_pipeline'
      ? definition.replace('    digest(', '    extensions.digest(')
      : definition;
    if (/(?<![a-z0-9_.])digest\s*\(/i.test(effective)
      && !/set search_path\s*=\s*[^\r\n]*\bextensions\b/i.test(effective)) {
      unresolved.push(name);
    }
  }
  assert.deepEqual(unresolved, []);
});

test('portal invitation and account setup fingerprints are computed by the server, with no SQL digest dependency', () => {
  const portalSql = [...functions.entries()]
    .filter(([name]) => /public\.(?:reserve|checkpoint|mark|finalize|confirm)_client_(?:portal_access|account_setup)_/.test(name))
    .map(([, definition]) => definition);
  assert.equal(portalSql.length, 7);
  for (const definition of portalSql) {
    assert.doesNotMatch(definition, /\bdigest\s*\(/i);
    assert.match(definition, /p_request_fingerprint/);
  }
  const invitation = fs.readFileSync(path.join(root, 'netlify', 'functions', 'client-portal-access.js'), 'utf8');
  assert.match(invitation, /function operationFingerprint\(input\)[\s\S]*?crypto\.createHash\('sha256'\)[\s\S]*?\.digest\('hex'\)/);
  assert.match(invitation, /p_request_fingerprint: fingerprint/);
  const setup = fs.readFileSync(path.join(root, 'netlify', 'functions', 'client-account-setup.js'), 'utf8');
  assert.match(setup, /function passwordRequestFingerprint\([\s\S]*?createHmac\('sha256', SERVICE_KEY\)[\s\S]*?\.digest\('hex'\)/);
});
