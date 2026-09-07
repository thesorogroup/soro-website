-- Forward-only repair for Client creation and contact/request mutations.
-- Migration 036's SECURITY DEFINER RPC excludes extensions from its search_path,
-- while Supabase installs pgcrypto there. Qualify only its fingerprint call.
-- Portal invitation/account-setup RPCs receive server-generated fingerprints;
-- their SQL does not invoke digest and does not need this repair.
begin;

do $migration$
declare
  v_function_oid oid := pg_catalog.to_regprocedure(
    'public.change_client_pipeline(uuid,uuid,text,timestamptz,uuid,uuid,jsonb)'
  );
  v_digest_oid oid := pg_catalog.to_regprocedure('extensions.digest(bytea,text)');
  v_before_metadata jsonb;
  v_after_metadata jsonb;
  v_definition text;
  v_source text;
  v_expected_source text;
  v_after_source text;
  v_original_fingerprint constant text := pg_catalog.replace($fingerprint$  v_fingerprint := encode(
    digest(
      convert_to(concat_ws(
        '|', v_action, coalesce(p_entity_id::text, ''), coalesce(p_parent_id::text, ''),
        coalesce(p_expected_updated_at::text, ''), v_payload::text
      ), 'utf8'),
      'sha256'
    ),
    'hex'
  );$fingerprint$, E'\r\n', E'\n');
  v_fixed_fingerprint text := pg_catalog.replace(
    v_original_fingerprint, '    digest(', '    extensions.digest('
  );
begin
  if v_function_oid is null then
    raise exception 'Migration 043 requires the existing Client pipeline RPC from migration 036.';
  end if;
  if v_digest_oid is null or not exists (
    select 1
    from pg_catalog.pg_depend as dependency
    join pg_catalog.pg_extension as extension on extension.oid = dependency.refobjid
    where dependency.classid = 'pg_catalog.pg_proc'::regclass
      and dependency.objid = v_digest_oid
      and dependency.refclassid = 'pg_catalog.pg_extension'::regclass
      and dependency.deptype = 'e'
      and extension.extname = 'pgcrypto'
  ) then
    raise exception 'Migration 043 requires pgcrypto extensions.digest(bytea,text).';
  end if;

  select pg_catalog.to_jsonb(routine), pg_catalog.pg_get_functiondef(routine.oid), routine.prosrc
    into strict v_before_metadata, v_definition, v_source
  from pg_catalog.pg_proc as routine
  where routine.oid = v_function_oid;

  if v_before_metadata ->> 'prosecdef' <> 'true'
    or v_before_metadata ->> 'prokind' <> 'f' then
    raise exception 'Migration 043 requires the existing SECURITY DEFINER Client pipeline function.';
  end if;

  -- Match the complete known expression, allowing either source line ending.
  -- Retain the live definition so later changes, owner, ACL and every function
  -- setting survive; do not redeclare an older copy of the full workflow.
  if pg_catalog.strpos(pg_catalog.replace(v_source, E'\r\n', E'\n'), v_original_fingerprint) > 0 then
    if pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, 'digest(', ''))
      <> pg_catalog.length('digest(') then
      raise exception 'Migration 043 found an unexpected Client pipeline digest expression.';
    end if;
    v_expected_source := pg_catalog.replace(v_source, '    digest(', '    extensions.digest(');
    execute pg_catalog.replace(v_definition, '    digest(', '    extensions.digest(');
  elsif pg_catalog.strpos(pg_catalog.replace(v_source, E'\r\n', E'\n'), v_fixed_fingerprint) > 0
    and pg_catalog.length(v_source) - pg_catalog.length(pg_catalog.replace(v_source, 'digest(', ''))
      = pg_catalog.length('digest(') then
    -- A repeat application is harmless, including after a verified manual fix.
    v_expected_source := v_source;
  else
    raise exception 'Migration 043 found an unrecognized Client pipeline fingerprint; no changes were applied.';
  end if;

  select pg_catalog.to_jsonb(routine), routine.prosrc
    into strict v_after_metadata, v_after_source
  from pg_catalog.pg_proc as routine
  where routine.oid = v_function_oid;

  -- pg_proc includes the OID, owner, ACL, SECURITY DEFINER flag, search_path and
  -- all other function settings. Any difference beyond the source aborts this
  -- transaction, as does any unrelated source alteration.
  if (v_after_metadata - 'prosrc') is distinct from (v_before_metadata - 'prosrc')
    or v_after_source is distinct from v_expected_source then
    raise exception 'Migration 043 could not preserve the Client pipeline definition and security settings.';
  end if;
end;
$migration$;

commit;
