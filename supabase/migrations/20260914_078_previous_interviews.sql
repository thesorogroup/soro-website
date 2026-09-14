-- Record interviews held before Soro scheduling existed without fabricating meetings,
-- timestamps, interviewer accounts, invitations, reminders, or result tasks.
begin;

alter table public.talent_interviews
  add column record_source text not null default 'scheduled' check(record_source in ('scheduled','historical')),
  add column occurred_on date,
  alter column interviewer_email_snapshot drop not null;

-- Replace only the original schedule requirement; keep every unrelated constraint.
do $constraint$
declare item record; matches integer:=0;
begin
  for item in select conname from pg_constraint
    where conrelid='public.talent_interviews'::regclass and contype='c'
      and pg_get_expr(conbin,conrelid) like '%ends_at > starts_at%'
      and pg_get_expr(conbin,conrelid) like '%timezone IS NOT NULL%'
  loop
    matches:=matches+1;
    execute format('alter table public.talent_interviews drop constraint %I',item.conname);
  end loop;
  if matches<>1 then raise exception 'Expected exactly one existing interview schedule constraint; found %',matches;end if;
end $constraint$;

alter table public.talent_interviews add constraint talent_interviews_record_source_fields_check check (
  (record_source='scheduled' and occurred_on is null and interviewer_email_snapshot is not null
    and starts_at is not null and ends_at is not null and ends_at>starts_at and timezone is not null)
  or
  (record_source='historical' and status='completed' and outcome is not null
    and starts_at is null and ends_at is null and timezone is null
    and interviewer_user_id is null and interviewer_email_snapshot is null and additional_attendees='[]'::jsonb
    and calendar_sync_status='not_applicable' and calendar_sync_action is null
    and calendar_transaction_id is null and calendar_request_id is null
    and microsoft_event_id is null and microsoft_join_url is null and microsoft_organizer_snapshot is null
    and microsoft_last_error_code is null and calendar_sync_started_at is null
    and follow_through_generation is null and follow_through_actor_id is null and follow_through_started_at is null)
);

-- Add one audited branch to the existing authority/idempotency/concurrency boundary.
-- Checked anchors deliberately abort deployment if prerequisite function bodies differ.
do $patch$
declare item record; definition text; anchor text; replacement text; matches integer;
begin
 for item in select * from (values
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$    'retry_calendar_sync', 'save_reference', 'record_reference_attempt',$old$,
  $new$    'record_previous_interview', 'retry_calendar_sync', 'save_reference', 'record_reference_attempt',$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$  if v_action = 'schedule_interview' then$old$,
  $new$  if v_action = 'record_previous_interview' then
    if v_applicant.archived_at is not null or v_applicant.status::text not in ('in_review','needs_more_info','bench_ready') then
      raise exception using errcode='P0001',message='Start or reopen review before recording a previous interview.';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(v_payload) k)
      is distinct from array['interviewId','interviewerName','note','occurredOn','outcome','scorecard']::text[]
      or jsonb_typeof(v_payload->'interviewId') not in ('null','string')
      or jsonb_typeof(v_payload->'occurredOn') not in ('null','string')
      or jsonb_typeof(v_payload->'interviewerName')<>'string'
      or char_length(btrim(v_payload->>'interviewerName')) not between 1 and 180
      or jsonb_typeof(v_payload->'outcome')<>'string'
      or v_payload->>'outcome' not in ('recommended','follow_up','not_recommended')
      or jsonb_typeof(v_payload->'note')<>'string'
      or char_length(btrim(v_payload->>'note')) not between 1 and 4000
      or jsonb_typeof(v_payload->'scorecard')<>'object' then
      raise exception using errcode='22023',message='Complete the previous interview details.';
    end if;
    if v_payload->>'occurredOn' is not null and (
      (v_payload->>'occurredOn') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (v_payload->>'occurredOn')::date>current_date
      or to_char((v_payload->>'occurredOn')::date,'YYYY-MM-DD')<>v_payload->>'occurredOn') then
      raise exception using errcode='22023',message='Use a valid past interview date or leave it unknown.';
    end if;
    if (select array_agg(k order by k) from jsonb_object_keys(v_payload->'scorecard') k)
       is distinct from array['communication','overall','preparedness','roleFit']::text[]
      or exists(select 1 from jsonb_each(v_payload->'scorecard') s where
        jsonb_typeof(s.value) not in ('null','number') or
        (jsonb_typeof(s.value)='number' and (s.value::text !~ '^[1-5]$'))) then
      raise exception using errcode='22023',message='Scores must be whole numbers from 1 to 5 or blank.';
    end if;

    select * into v_interview from public.talent_interviews
      where organization_id=v_actor.organization_id and applicant_id=p_applicant_id for update;
    if v_interview.id is null then
      if p_expected_updated_at is not null or v_payload->>'interviewId' is not null then
        raise exception using errcode='P0001',message='This verification changed after it was opened.';
      end if;
      insert into public.talent_interviews(organization_id,applicant_id,record_source,occurred_on,
        interviewer_name_snapshot,status,outcome,scorecard,private_notes,calendar_sync_status,follow_through_started_at,updated_at)
      values(v_actor.organization_id,p_applicant_id,'historical',(v_payload->>'occurredOn')::date,
        btrim(v_payload->>'interviewerName'),'completed',v_payload->>'outcome',v_payload->'scorecard',
        btrim(v_payload->>'note'),'not_applicable',null,v_now) returning * into v_interview;
      v_before:=null;
    else
      if (v_payload->>'interviewId')::uuid is distinct from v_interview.id
        or p_expected_updated_at is null or p_expected_updated_at is distinct from v_interview.updated_at then
        raise exception using errcode='P0001',message='This verification changed after it was opened.';
      end if;
      if not (v_interview.record_source='historical' or
        (v_interview.status='cancelled' and v_interview.calendar_sync_status='not_applicable')) then
        raise exception using errcode='P0001',message='Use the current interview record. Scheduled and recorded interviews cannot be replaced by a previous interview.';
      end if;
      v_before:=private.interview_history_json(v_interview);
      if v_interview.record_source<>'historical' then
        insert into private.talent_interview_history(interview_id,round_number,organization_id,applicant_id,snapshot)
        values(v_interview.id,v_interview.round_number,v_actor.organization_id,p_applicant_id,
          jsonb_build_object('record',to_jsonb(v_interview),'public',private.interview_history_json(v_interview)));
      end if;
      update public.talent_interviews set
        round_number=round_number+case when record_source='historical' then 0 else 1 end,
        record_source='historical',occurred_on=(v_payload->>'occurredOn')::date,
        interviewer_user_id=null,interviewer_name_snapshot=btrim(v_payload->>'interviewerName'),interviewer_email_snapshot=null,
        additional_attendees='[]'::jsonb,status='completed',outcome=v_payload->>'outcome',
        scorecard=v_payload->'scorecard',private_notes=btrim(v_payload->>'note'),
        starts_at=null,ends_at=null,timezone=null,calendar_sync_status='not_applicable',calendar_sync_action=null,
        calendar_transaction_id=null,calendar_request_id=null,microsoft_event_id=null,microsoft_join_url=null,
        microsoft_organizer_snapshot=null,microsoft_last_error_code=null,calendar_sync_started_at=null,
        follow_through_generation=null,follow_through_actor_id=null,follow_through_started_at=null,updated_at=v_now
      where id=v_interview.id returning * into v_interview;
    end if;
    v_after:=private.interview_history_json(v_interview);
    -- No calendar command: this records an event which already happened.
    v_calendar_action:=null;

  elsif v_action = 'schedule_interview' then$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$        status = 'scheduled',
        round_number = round_number +$old$,
  $new$        status = 'scheduled',
        record_source='scheduled',occurred_on=null,
        round_number = round_number +$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$    elsif v_action = 'record_interview_outcome' then
      if v_interview.status$old$,
  $new$    elsif v_action = 'record_interview_outcome' then
      if v_interview.record_source='historical' then
        raise exception using errcode='P0001',message='Use Edit Previous Interview to update this historical record.';
      end if;
      if v_interview.status$new$,1),
 ('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamp with time zone,jsonb)',
  $old$case when v_action in ('cancel_interview', 'record_interview_outcome', 'set_reference_outcome')$old$,
  $new$case when v_action in ('cancel_interview', 'record_interview_outcome', 'record_previous_interview', 'set_reference_outcome')$new$,1),
 ('private.talent_verification_state_json(uuid,public.platform_role,uuid)',
  $old$    'roundNumber', interview.round_number,$old$,
  $new$    'recordSource', interview.record_source,'occurredOn',interview.occurred_on,
    'roundNumber', interview.round_number,$new$,1),
 ('private.interview_history_json(public.talent_interviews)',
  $old$'status',p_interview.status,$old$,
  $new$'recordSource',p_interview.record_source,'occurredOn',p_interview.occurred_on,
  'status',p_interview.status,$new$,1)
 ) edits(signature,old_text,new_text,expected_matches)
 loop
   definition:=replace(pg_get_functiondef(item.signature::regprocedure),E'\r\n',E'\n');
   -- Windows clipboard transfer also changes newlines inside dollar-quoted text.
   -- Normalize all three inputs equally while retaining exact checked anchors.
   anchor:=replace(item.old_text,E'\r\n',E'\n');
   replacement:=replace(item.new_text,E'\r\n',E'\n');
   matches:=(length(definition)-length(replace(definition,anchor,'')))/length(anchor);
   if matches<>item.expected_matches then
     raise exception 'Previous interview patch expected % matches, found % in %; anchor: %',
       item.expected_matches,matches,item.signature,left(regexp_replace(item.old_text,'[[:space:]]+',' ','g'),120);
   end if;
   execute replace(definition,anchor,replacement);
 end loop;
end $patch$;

-- Preserve the existing activity catalog wrappers, including review deferrals.
alter function private.activity_catalog(text,text) rename to activity_catalog_before_previous_interviews;
create function private.activity_catalog(t text,e text) returns jsonb language sql immutable set search_path=pg_catalog,private as $$
 select case when t='talent_verification' and e='record_previous_interview' then
  jsonb_build_object('action','Previous Talent interview recorded','category','review','external',false)
  else private.activity_catalog_before_previous_interviews(t,e) end;
$$;
revoke all on function private.activity_catalog(text,text),private.activity_catalog_before_previous_interviews(text,text)
 from public,anon,authenticated,service_role;

alter table public.talent_verification_operations drop constraint talent_verification_operations_action_check;
alter table public.talent_verification_operations add constraint talent_verification_operations_action_check check(action in
 ('schedule_interview','reschedule_interview','schedule_follow_up_interview','cancel_interview','record_interview_outcome','record_previous_interview','retry_calendar_sync','save_reference','record_reference_attempt','set_reference_outcome','remove_reference','calendar_sync_result'));

-- Existing browser and organization boundaries remain unchanged.
revoke all on function public.mutate_talent_verification(uuid,uuid,uuid,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.mutate_talent_verification(uuid,uuid,uuid,text,timestamptz,jsonb) to service_role;
commit;
