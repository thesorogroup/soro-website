-- Optional internal guests share the interview invitation, not portal permissions.
-- Snapshots make calendar retries deterministic even if staff contact details change.
begin;

alter table public.talent_interviews
  add column additional_attendees jsonb not null default '[]'::jsonb
  check (jsonb_typeof(additional_attendees) = 'array' and jsonb_array_length(additional_attendees) <= 50);

create function private.talent_interview_staff(p_organization_id uuid)
returns jsonb language sql stable security definer
set search_path = pg_catalog, public, private as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', access.id, 'name', coalesce(nullif(btrim(access.display_name), ''), profile.full_name),
    'role', access.role::text
  ) order by coalesce(nullif(btrim(access.display_name), ''), profile.full_name), access.id), '[]'::jsonb)
  from public.platform_users access
  join public.employee_profiles profile on profile.user_id = access.id and profile.organization_id = access.organization_id
  where access.organization_id = p_organization_id and access.active = true
    and access.role in ('admin', 'sales_management', 'sales', 'talent_management', 'billing')
    and btrim(profile.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
$$;

create function private.talent_interview_attendee_names(p_attendees jsonb)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', person->>'id', 'name', person->>'name')), '[]'::jsonb)
  from jsonb_array_elements(p_attendees) person;
$$;

create function private.resolve_talent_interview_attendees(p_organization_id uuid, p_interviewer_id uuid, p_ids jsonb)
returns jsonb language plpgsql stable security definer
set search_path = pg_catalog, public, private as $$
declare v_result jsonb; v_count integer;
begin
  if p_ids is null or jsonb_typeof(p_ids) <> 'array' then
    raise exception using errcode = '22023', message = 'Choose company employees for additional attendees.';
  end if;
  if jsonb_array_length(p_ids) > 50 or exists (
    select 1 from jsonb_array_elements(p_ids) item
    where jsonb_typeof(item) <> 'string' or trim(both '"' from item::text) !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  ) then
    raise exception using errcode = '22023', message = 'Choose up to 50 company employees for additional attendees.';
  end if;
  select count(distinct value::uuid) into v_count from jsonb_array_elements_text(p_ids);
  if v_count <> jsonb_array_length(p_ids) then
    raise exception using errcode = '22023', message = 'Choose each additional attendee only once.';
  end if;
  -- Completing a portal password is not required to receive a company calendar invitation.
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', access.id, 'name', coalesce(nullif(btrim(access.display_name), ''), profile.full_name),
    'email', lower(btrim(profile.email))
  ) order by access.id), '[]'::jsonb) into v_result
  from public.platform_users access
  join public.employee_profiles profile on profile.user_id = access.id and profile.organization_id = access.organization_id
  where access.id in (select value::uuid from jsonb_array_elements_text(p_ids))
    and access.organization_id = p_organization_id and access.active = true
    and access.role in ('admin', 'sales_management', 'sales', 'talent_management', 'billing')
    and btrim(profile.email) ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
  if jsonb_array_length(v_result) <> v_count then
    raise exception using errcode = '42501', message = 'An additional attendee is no longer an active company employee. Refresh the interview and select again.';
  end if;
  return coalesce((select jsonb_agg(person) from jsonb_array_elements(v_result) person
    where (person->>'id')::uuid <> p_interviewer_id), '[]'::jsonb);
end;
$$;

revoke all on function private.talent_interview_staff(uuid), private.talent_interview_attendee_names(jsonb),
  private.resolve_talent_interview_attendees(uuid, uuid, jsonb) from public, anon, authenticated;

-- Guard every replacement so a changed deployed function aborts the migration.
do $patch$
declare item record; definition text; matches integer;
begin
  for item in select * from (values
    ('private.talent_verification_state_json(uuid,public.platform_role,uuid)',
      $old$    'outcome', interview.outcome,$old$,
      $new$    'additionalAttendees', private.talent_interview_attendee_names(interview.additional_attendees),
    'outcome', interview.outcome,$new$, 1),
    ('private.talent_verification_state_json(uuid,public.platform_role,uuid)',
      $old$    'interviewers', v_interviewers,$old$,
      $new$    'availableAttendees', private.talent_interview_staff(p_organization_id),
    'interviewers', v_interviewers,$new$, 1),
    ('private.talent_calendar_command_json(uuid,uuid,uuid,uuid,text)',
      $old$    'applicantName', applicant.full_name,$old$,
      $new$    'additionalAttendees', interview.additional_attendees,
    'applicantName', applicant.full_name,$new$, 1),
    ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
      $old$      status, starts_at, ends_at, timezone,$old$,
      $new$      additional_attendees, status, starts_at, ends_at, timezone,$new$, 1),
    ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
      $old$      v_interviewer_name, v_interviewer_email, 'scheduled',$old$,
      $new$      v_interviewer_name, v_interviewer_email,
      private.resolve_talent_interview_attendees(v_actor.organization_id, (v_payload->>'interviewerUserId')::uuid, coalesce(v_payload->'additionalAttendeeUserIds', '[]'::jsonb)), 'scheduled',$new$, 1),
    ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
      $old$        interviewer_email_snapshot = v_interviewer_email,$old$,
      $new$        interviewer_email_snapshot = v_interviewer_email,
        additional_attendees = case when v_payload ? 'additionalAttendeeUserIds'
          then private.resolve_talent_interview_attendees(v_actor.organization_id, (v_payload->>'interviewerUserId')::uuid, v_payload->'additionalAttendeeUserIds')
          else coalesce((select jsonb_agg(person) from jsonb_array_elements(additional_attendees) person
            where (person->>'id')::uuid <> (v_payload->>'interviewerUserId')::uuid), '[]'::jsonb) end,$new$, 1),
    ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
      $old$'interviewerId', v_interview.interviewer_user_id);$old$,
      $new$'interviewerId', v_interview.interviewer_user_id, 'additionalAttendees', private.talent_interview_attendee_names(v_interview.additional_attendees));$new$, 1),
    ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
      $old$'calendarStatus', v_interview.calendar_sync_status);$old$,
      $new$'calendarStatus', v_interview.calendar_sync_status, 'additionalAttendees', private.talent_interview_attendee_names(v_interview.additional_attendees));$new$, 2)
  ) as edits(signature, old_text, new_text, expected_matches)
  loop
    definition := replace(pg_get_functiondef(item.signature::regprocedure), E'\r\n', E'\n');
    matches := (length(definition) - length(replace(definition, item.old_text, ''))) / length(item.old_text);
    if matches <> item.expected_matches then
      raise exception 'Interview attendee patch expected % matches, found % in %', item.expected_matches, matches, item.signature;
    end if;
    execute replace(definition, item.old_text, item.new_text);
  end loop;
end;
$patch$;

comment on column public.talent_interviews.additional_attendees is 'Server-validated internal employee recipients with immutable-per-operation name/email snapshots; never grants portal access.';
commit;
