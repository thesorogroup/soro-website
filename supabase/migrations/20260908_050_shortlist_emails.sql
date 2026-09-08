-- Future candidate-review emails only. No historical notification backfill.
begin;
alter table public.confirmation_outbox drop constraint confirmation_event_type,
  drop constraint confirmation_safe_payload;
alter table public.confirmation_outbox add constraint confirmation_event_type check(event_type in ('support_ticket_created','client_profile_updated','support_ticket_reply','support_ticket_resolved','support_ticket_assigned','client_shortlist_ready','client_shortlist_response')),
  add constraint confirmation_safe_payload check((event_type='client_profile_updated' and payload='{}'::jsonb)
    or(event_type in ('client_shortlist_ready','client_shortlist_response') and payload ? 'requestId' and payload-'requestId'='{}'::jsonb and jsonb_typeof(payload->'requestId')='string' and payload->>'requestId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
    or(event_type in ('support_ticket_created','support_ticket_reply','support_ticket_resolved','support_ticket_assigned') and payload ? 'ticketNumber' and payload-'ticketNumber'='{}'::jsonb and jsonb_typeof(payload->'ticketNumber')='string' and payload->>'ticketNumber' ~ '^SUP-[A-F0-9]{8}$'));

create function private.queue_shortlist_confirmation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare request_id uuid;
begin
  select hiring_request_id into strict request_id from public.client_shortlists where id=new.shortlist_id and organization_id=new.organization_id;
  perform private.enqueue_confirmation(new.notification_type,new.id,new.organization_id,new.recipient_user_id,jsonb_build_object('requestId',request_id));
  return new;
end $$;
create trigger queue_shortlist_confirmation after insert on public.client_shortlist_notifications
for each row execute function private.queue_shortlist_confirmation();

create function private.queue_client_pass_confirmation() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare owner_id uuid;
begin
  select c.sales_owner_id into owner_id from public.clients c
  join public.platform_users a on a.id=c.sales_owner_id and a.organization_id=c.organization_id
  where c.id=new.client_id and c.organization_id=new.organization_id and c.archived_at is null;
  if owner_id is not null then
    perform private.enqueue_confirmation('client_shortlist_response',new.id,new.organization_id,owner_id,jsonb_build_object('requestId',new.hiring_request_id));
  end if;
  return new;
end $$;
create trigger queue_client_pass_confirmation after insert on public.client_candidate_decisions
for each row when(new.decision='passed') execute function private.queue_client_pass_confirmation();

create function private.shortlist_confirmation_allowed(q public.confirmation_outbox)
returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
with source as (
  select s.id shortlist_id,s.organization_id,s.client_id,s.hiring_request_id,n.shortlist_item_id,false is_pass
  from public.client_shortlist_notifications n join public.client_shortlists s on s.id=n.shortlist_id and s.organization_id=n.organization_id
  where n.id=q.source_id and n.organization_id=q.organization_id and n.recipient_user_id=q.recipient_user_id
    and n.notification_type=q.event_type and q.event_type in ('client_shortlist_ready','client_shortlist_response') and s.status='sent'
  union all
  select s.id,s.organization_id,s.client_id,s.hiring_request_id,d.shortlist_item_id,true
  from public.client_candidate_decisions d join public.client_shortlists s on s.id=d.shortlist_id and s.organization_id=d.organization_id
    and s.client_id=d.client_id and s.hiring_request_id=d.hiring_request_id
  join public.client_shortlist_items i on i.id=d.shortlist_item_id and i.shortlist_id=s.id and i.organization_id=d.organization_id and i.applicant_id=d.applicant_id
  where q.event_type='client_shortlist_response' and d.id=q.source_id and d.organization_id=q.organization_id
    and d.decision='passed' and s.status='sent' and i.workflow_state='passed' and i.removed_at is not null
)
select exists (
  select 1 from source x join public.clients c on c.id=x.client_id and c.organization_id=x.organization_id and c.archived_at is null
  join public.hiring_requests h on h.id=x.hiring_request_id and h.client_id=c.id and h.organization_id=x.organization_id
  join public.platform_users a on a.id=q.recipient_user_id and a.organization_id=x.organization_id and a.active and not a.must_change_password
  left join public.client_shortlist_items i on i.id=x.shortlist_item_id and i.shortlist_id=x.shortlist_id and i.organization_id=x.organization_id
  where q.payload=jsonb_build_object('requestId',x.hiring_request_id) and case when q.event_type='client_shortlist_ready' then
    a.role in ('client_admin','client_reviewer') and private.is_open_hiring_request_status(h.status)
    and exists(select 1 from public.client_portal_memberships m join public.client_contacts cc on cc.id=m.client_contact_id
      and cc.client_id=m.client_id and cc.organization_id=m.organization_id and cc.active
      where m.user_id=a.id and m.organization_id=a.organization_id and m.client_id=c.id and m.active)
  else a.role='sales' and c.sales_owner_id=a.id and (x.is_pass or (
    i.removed_at is null and i.client_response in ('interested','request_interview')
    and exists(select 1 from public.applicants t where t.id=i.applicant_id and t.organization_id=i.organization_id
      and t.archived_at is null and t.sales_owner_id=a.id)
  )) end
);
$$;

-- Both claim and prepare already call this guard (048). Preserve support rules.
create or replace function private.support_confirmation_allowed(q public.confirmation_outbox) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare ticket uuid;
begin
 if q.event_type in ('client_shortlist_ready','client_shortlist_response') then return private.shortlist_confirmation_allowed(q);end if;
 if q.event_type='client_profile_updated' then perform private.active_support_actor(q.recipient_user_id);return true;end if;
 if q.event_type='support_ticket_created' then ticket:=q.source_id;
 else select ticket_id into ticket from public.support_entries where id=q.source_id;end if;
 return ticket is not null and private.support_can_read(q.recipient_user_id,ticket);
exception when insufficient_privilege then return false;
end $$;

-- Only counts and timestamps leave the outbox; reuse the actual workspace scope.
create function public.get_client_shortlist_email_delivery(p_actor_user_id uuid,p_hiring_request_id uuid default null) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare w jsonb;result jsonb;
begin
  if p_hiring_request_id is null then w:=public.get_client_shortlist_workspace(p_actor_user_id);
  else
    w:=public.get_client_placement_workspace(p_actor_user_id,p_hiring_request_id);
    w:=w||jsonb_build_object('shortlists',coalesce((select jsonb_agg(jsonb_build_object('shortlistId',s.id))
      from public.client_shortlists s join public.platform_users a on a.id=p_actor_user_id and a.organization_id=s.organization_id
      where s.hiring_request_id=p_hiring_request_id and w->'request'->>'hiringRequestId'=p_hiring_request_id::text),'[]'::jsonb));
  end if;
  if coalesce(w->>'viewerRole','') not in ('admin','sales_management','sales') then
    raise exception using errcode='42501',message='Staff shortlist access required.';
  end if;
  with visible as (
    select (v->>'shortlistId')::uuid id from jsonb_array_elements(w->'shortlists') v
  ), sources as (
    select n.id,n.organization_id,n.shortlist_id,n.recipient_user_id,n.notification_type event_type
    from public.client_shortlist_notifications n join visible v on v.id=n.shortlist_id
    union all
    select d.id,d.organization_id,d.shortlist_id,null::uuid,'client_shortlist_response'
    from public.client_candidate_decisions d join visible v on v.id=d.shortlist_id where d.decision='passed'
  ), grouped as (
    select s.shortlist_id,
      count(*) filter(where q.event_type='client_shortlist_ready')::integer client_count,
      count(*) filter(where q.event_type='client_shortlist_response')::integer sales_count,
      count(*) filter(where q.status='sent')::integer sent_count,
      count(*) filter(where q.status in ('pending','sending'))::integer pending_count,
      count(*) filter(where q.status='manual_review')::integer review_count,
      max(q.sent_at) last_sent_at
    from sources s join public.confirmation_outbox q on q.source_id=s.id and q.organization_id=s.organization_id
      and q.event_type=s.event_type and(s.recipient_user_id is null or s.recipient_user_id=q.recipient_user_id)
    join public.platform_users actor on actor.id=p_actor_user_id and actor.organization_id=q.organization_id
    group by s.shortlist_id
  )
  select coalesce(jsonb_agg(jsonb_build_object('shortlistId',shortlist_id,'clientCount',client_count,'salesCount',sales_count,
    'sentCount',sent_count,'pendingCount',pending_count,'reviewCount',review_count,'lastSentAt',last_sent_at) order by shortlist_id),'[]'::jsonb) into result from grouped;
  return result;
end $$;
revoke all on function private.queue_shortlist_confirmation(),private.queue_client_pass_confirmation(),private.shortlist_confirmation_allowed(public.confirmation_outbox),private.support_confirmation_allowed(public.confirmation_outbox) from public,anon,authenticated,service_role;
revoke all on function public.get_client_shortlist_email_delivery(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_client_shortlist_email_delivery(uuid,uuid) to service_role;
commit;
