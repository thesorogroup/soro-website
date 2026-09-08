begin;
create function public.claim_confirmation_outbox(p_limit integer default 3)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.confirmation_outbox%rowtype; v_now timestamptz; v_token uuid; r jsonb:='[]'::jsonb; v_reason text;
begin
  if p_limit is null or p_limit not between 1 and 20 then raise exception using errcode='22023',message='Invalid batch size.'; end if;
  for q in select o.* from public.confirmation_outbox o where (o.status='pending' and o.next_attempt_at<=clock_timestamp()) or (o.status='sending' and o.lease_expires_at<=clock_timestamp()) order by o.created_at,o.id limit p_limit for update skip locked loop
    v_now:=clock_timestamp();v_reason:=null;
    if q.first_attempt_at is not null and q.first_attempt_at<=v_now-interval '23 hours' then v_reason:='idempotency_window_elapsed';
    elsif q.attempt_count>=20 then v_reason:='attempt_limit';
    elsif not exists(select 1 from public.platform_users a join auth.users u on u.id=a.id where a.id=q.recipient_user_id and a.organization_id=q.organization_id and a.active and not a.must_change_password and u.email_confirmed_at is not null and lower(btrim(u.email))=q.recipient_email) then v_reason:='recipient_unavailable'; end if;
    if v_reason is not null then update public.confirmation_outbox set status='manual_review',lease_token=null,lease_expires_at=null,last_error_code=v_reason where id=q.id;continue;end if;
    v_token:=gen_random_uuid();
    update public.confirmation_outbox set status='sending',lease_token=v_token,lease_expires_at=v_now+interval '2 minutes',attempt_count=attempt_count+1 where id=q.id;
    r:=r||jsonb_build_array(jsonb_build_object('outboxId',q.id,'leaseToken',v_token,'to',q.recipient_email,'eventType',q.event_type,'payload',q.payload,'requestBody',q.request_body,'idempotencyKey','soro-confirmation/'||q.id::text));
  end loop;
  return r;
end $$;
revoke all on function public.claim_confirmation_outbox(integer) from public,anon,authenticated;
grant execute on function public.claim_confirmation_outbox(integer) to service_role;

create function public.prepare_confirmation(p_outbox_id uuid,p_lease_token uuid,p_request_body text)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.confirmation_outbox%rowtype;b jsonb;v_now timestamptz;
begin
  select * into q from public.confirmation_outbox where id=p_outbox_id for update;
  v_now:=clock_timestamp();
  if not found or q.status<>'sending' or q.lease_token is distinct from p_lease_token or q.lease_expires_at<=v_now then raise exception using errcode='42501',message='Lease expired.';end if;
  if q.first_attempt_at is not null and q.first_attempt_at<=v_now-interval '23 hours' then raise exception using errcode='42501',message='Delivery review required.';end if;
  if not exists(select 1 from public.platform_users a join auth.users u on u.id=a.id where a.id=q.recipient_user_id and a.organization_id=q.organization_id and a.active and not a.must_change_password and u.email_confirmed_at is not null and lower(btrim(u.email))=q.recipient_email) then raise exception using errcode='42501',message='Recipient unavailable.';end if;
  if q.request_body is not null then return q.request_body;end if;
  if p_request_body is null or octet_length(p_request_body) not between 2 and 50000 then raise exception using errcode='22023',message='Invalid confirmation.';end if;
  b:=p_request_body::jsonb;
  if jsonb_typeof(b)<>'object' or not(b ? 'to') or b->'to'<>jsonb_build_array(q.recipient_email) or b ?| array['cc','bcc','attachments'] or b->>'from' is distinct from 'Soro Group <do-not-reply@thesorogroup.com>' then raise exception using errcode='22023',message='Invalid confirmation recipient.';end if;
  update public.confirmation_outbox set request_body=p_request_body,first_attempt_at=v_now where id=q.id;
  return p_request_body;
end $$;
revoke all on function public.prepare_confirmation(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.prepare_confirmation(uuid,uuid,text) to service_role;

create function public.complete_confirmation(p_outbox_id uuid,p_lease_token uuid,p_outcome text,p_provider_message_id text default null,p_error_code text default null)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare q public.confirmation_outbox%rowtype;v_now timestamptz;v_status text;
begin
  if p_outbox_id is null or p_lease_token is null or p_outcome is null or p_outcome not in ('sent','retry','review') or(p_error_code is not null and p_error_code !~ '^[a-z][a-z0-9_]{0,79}$') or(p_outcome='sent' and(p_provider_message_id is null or p_provider_message_id !~ '^[a-zA-Z0-9_-]{1,200}$')) then raise exception using errcode='22023',message='Invalid confirmation result.';end if;
  select * into q from public.confirmation_outbox where id=p_outbox_id for update;
  if not found or q.lease_token is distinct from p_lease_token then raise exception using errcode='42501',message='Lease expired.';end if;
  if q.status in ('pending','sent','manual_review') then return jsonb_build_object('status',q.status);end if;
  v_now:=clock_timestamp();
  if q.status<>'sending' or q.lease_expires_at is null or q.lease_expires_at<=v_now then raise exception using errcode='42501',message='Lease expired.';end if;
  if p_outcome='sent' then
    if q.request_body is null or q.first_attempt_at is null then raise exception using errcode='42501',message='Prepared confirmation required.';end if;
    v_status:='sent';
    update public.confirmation_outbox set status=v_status,provider_message_id=p_provider_message_id,sent_at=v_now,last_error_code=null,lease_expires_at=null where id=q.id;
  else
    v_status:=case when p_outcome='review' or q.attempt_count>=20 or(q.first_attempt_at is not null and q.first_attempt_at<=v_now-interval '23 hours') then 'manual_review' else 'pending' end;
    update public.confirmation_outbox set status=v_status,last_error_code=coalesce(p_error_code,'delivery_unconfirmed'),lease_expires_at=null,next_attempt_at=v_now+make_interval(secs=>least(3600,15*(1<<least(q.attempt_count,8)))) where id=q.id;
  end if;
  return jsonb_build_object('status',v_status);
end $$;
revoke all on function public.complete_confirmation(uuid,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.complete_confirmation(uuid,uuid,text,text,text) to service_role;
commit;
