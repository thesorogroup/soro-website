-- Optional identity and naming preferences supplied by an applicant.
-- These fields help Soro address a person respectfully and are not screening
-- criteria. They remain separate from the applicant's legal name.

alter table public.applicants
  add column if not exists preferred_name text,
  add column if not exists gender_identity text,
  add column if not exists gender_identity_self_description text,
  add column if not exists pronouns text[] not null default '{}',
  add column if not exists pronouns_self_description text;

alter table public.applicants
  drop constraint if exists applicants_preferred_name_length,
  drop constraint if exists applicants_gender_identity_valid,
  drop constraint if exists applicants_gender_identity_self_description_valid,
  drop constraint if exists applicants_pronouns_valid,
  drop constraint if exists applicants_pronouns_prefer_not_exclusive,
  drop constraint if exists applicants_pronouns_self_description_valid;

alter table public.applicants
  add constraint applicants_preferred_name_length
    check (preferred_name is null or char_length(preferred_name) between 1 and 100),
  add constraint applicants_gender_identity_valid
    check (
      gender_identity is null
      or gender_identity in ('female', 'male', 'nonbinary', 'self_describe', 'prefer_not_to_disclose')
    ),
  add constraint applicants_gender_identity_self_description_valid
    check (
      (gender_identity = 'self_describe'
        and nullif(btrim(gender_identity_self_description), '') is not null
        and char_length(gender_identity_self_description) <= 120)
      or (gender_identity is distinct from 'self_describe' and gender_identity_self_description is null)
    ),
  add constraint applicants_pronouns_valid
    check (
      cardinality(pronouns) <= 6
      and array_position(pronouns, null) is null
      and pronouns <@ array['she_her', 'he_him', 'they_them', 'use_name', 'self_describe', 'prefer_not_to_disclose']::text[]
    ),
  add constraint applicants_pronouns_prefer_not_exclusive
    check (not ('prefer_not_to_disclose' = any(pronouns)) or cardinality(pronouns) = 1),
  add constraint applicants_pronouns_self_description_valid
    check (
      ('self_describe' = any(pronouns)
        and nullif(btrim(pronouns_self_description), '') is not null
        and char_length(pronouns_self_description) <= 120)
      or (not ('self_describe' = any(pronouns)) and pronouns_self_description is null)
    );

comment on column public.applicants.preferred_name is
  'Optional name the applicant or talent wants Soro to use; not a legal-name replacement.';
comment on column public.applicants.gender_identity is
  'Optional applicant identity preference; not an application evaluation criterion.';
comment on column public.applicants.gender_identity_self_description is
  'Applicant-provided wording when gender_identity is self_describe.';
comment on column public.applicants.pronouns is
  'Optional stable pronoun preference IDs selected by the applicant or talent.';
comment on column public.applicants.pronouns_self_description is
  'Applicant-provided wording when pronouns includes self_describe.';

-- The public application endpoint may refresh only applicant-supplied identity
-- fields on a repeat application. It cannot update staff-controlled fields.
grant update (
  preferred_name,
  gender_identity,
  gender_identity_self_description,
  pronouns,
  pronouns_self_description
) on table public.applicants to service_role;

-- Authenticated talent may maintain only these five identity-preference fields.
-- A SECURITY DEFINER RPC avoids adding an own-row UPDATE policy to applicants,
-- which would combine with existing table grants and expose other columns.
create or replace function public.update_own_identity_preferences(
  p_preferred_name text,
  p_gender_identity text,
  p_gender_identity_self_description text,
  p_pronouns text[],
  p_pronouns_self_description text
)
returns table (
  preferred_name text,
  gender_identity text,
  gender_identity_self_description text,
  pronouns text[],
  pronouns_self_description text
)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user_id uuid := auth.uid();
  v_preferred_name text := nullif(btrim(p_preferred_name), '');
  v_gender_identity text := nullif(btrim(p_gender_identity), '');
  v_gender_identity_self_description text := nullif(btrim(p_gender_identity_self_description), '');
  v_pronouns text[] := coalesce(p_pronouns, '{}'::text[]);
  v_pronouns_self_description text := nullif(btrim(p_pronouns_self_description), '');
  v_updated_count integer := 0;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'You must be signed in to update identity preferences.';
  end if;

  if v_preferred_name is not null and char_length(v_preferred_name) > 100 then
    raise exception using errcode = '22023', message = 'Preferred name must be 100 characters or fewer.';
  end if;

  if v_gender_identity is not null and v_gender_identity not in (
    'female', 'male', 'nonbinary', 'self_describe', 'prefer_not_to_disclose'
  ) then
    raise exception using errcode = '22023', message = 'Gender identity preference is not recognized.';
  end if;

  if v_gender_identity = 'self_describe' then
    if v_gender_identity_self_description is null then
      raise exception using errcode = '22023', message = 'Please provide the gender wording you want Soro to use.';
    end if;
    if char_length(v_gender_identity_self_description) > 120 then
      raise exception using errcode = '22023', message = 'Gender self-description must be 120 characters or fewer.';
    end if;
  else
    v_gender_identity_self_description := null;
  end if;

  if cardinality(v_pronouns) > 6
    or exists (
      select 1
      from unnest(v_pronouns) as selected(value)
      where selected.value is null
        or selected.value not in ('she_her', 'he_him', 'they_them', 'use_name', 'self_describe', 'prefer_not_to_disclose')
    ) then
    raise exception using errcode = '22023', message = 'Pronoun preferences contain an unrecognized selection.';
  end if;

  if cardinality(v_pronouns) <> (
    select count(distinct selected.value)::integer from unnest(v_pronouns) as selected(value)
  ) then
    raise exception using errcode = '22023', message = 'Pronoun preferences cannot contain duplicates.';
  end if;

  if 'prefer_not_to_disclose' = any(v_pronouns) and cardinality(v_pronouns) > 1 then
    raise exception using errcode = '22023', message = 'Choose either pronouns or prefer not to disclose, not both.';
  end if;

  if 'self_describe' = any(v_pronouns) then
    if v_pronouns_self_description is null then
      raise exception using errcode = '22023', message = 'Please provide the pronouns you want Soro to use.';
    end if;
    if char_length(v_pronouns_self_description) > 120 then
      raise exception using errcode = '22023', message = 'Pronoun self-description must be 120 characters or fewer.';
    end if;
  else
    v_pronouns_self_description := null;
  end if;

  return query
  update public.applicants as applicant
  set
    preferred_name = v_preferred_name,
    gender_identity = v_gender_identity,
    gender_identity_self_description = v_gender_identity_self_description,
    pronouns = v_pronouns,
    pronouns_self_description = v_pronouns_self_description
  where applicant.auth_user_id = v_user_id
  returning
    applicant.preferred_name,
    applicant.gender_identity,
    applicant.gender_identity_self_description,
    applicant.pronouns,
    applicant.pronouns_self_description;

  get diagnostics v_updated_count = row_count;
  if v_updated_count = 0 then
    raise exception using errcode = 'P0002', message = 'No talent profile is linked to this signed-in account.';
  end if;
end;
$$;

revoke all on function public.update_own_identity_preferences(text, text, text, text[], text) from public;
grant execute on function public.update_own_identity_preferences(text, text, text, text[], text) to authenticated;

comment on function public.update_own_identity_preferences(text, text, text, text[], text) is
  'Lets an authenticated talent update only their own optional identity and naming preferences.';
