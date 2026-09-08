-- Team-owned support queues. All writes pass through actor-scoped RPCs.
-- Existing tickets are retained; migration/backfill never sends notifications.
begin;
alter table public.support_tickets
  add column team text not null default 'admin' check(team in ('admin','sales','talent_management')),
  add column assigned_to_user_id uuid,
  add column version integer not null default 1 check(version>0),
  add foreign key(assigned_to_user_id,organization_id) references public.platform_users(id,organization_id);
alter table public.support_tickets drop constraint support_tickets_status_check;
update public.support_tickets set status='resolved' where status='closed';
alter table public.support_tickets add constraint support_tickets_status_check check(status in ('open','in_progress','waiting_on_client','resolved'));
update public.support_tickets set team=case when area='Talent profiles and documents' then 'talent_management' when area='Client records and placements' then 'sales' else 'admin' end;
create index support_team_queue_idx on public.support_tickets(organization_id,team,status,updated_at desc,id);

create table public.support_entries(
  id uuid primary key default gen_random_uuid(), seq integer generated always as identity unique,
  ticket_id uuid not null references public.support_tickets(id),
  actor_user_id uuid not null references public.platform_users(id),
  kind text not null check(kind in ('created','reply','note','status','assignment')),
  visibility text not null check(visibility in ('public','internal')),
  body text check(body is null or char_length(btrim(body)) between 1 and 5000),
  status text,team text,assignee_user_id uuid references public.platform_users(id),
  created_at timestamptz not null default now(),
  check((kind in ('reply','note'))=(body is not null)),
  check((kind in ('note','assignment') and visibility='internal') or(kind in ('created','reply','status') and visibility='public'))
);
create index support_entries_ticket_seq on public.support_entries(ticket_id,seq);
create table public.support_notifications(
  ticket_id uuid not null references public.support_tickets(id),recipient_user_id uuid not null references public.platform_users(id),
  visibility text not null check(visibility in ('public','internal')),
  latest_seq integer not null,read_seq integer not null default 0,
  primary key(ticket_id,recipient_user_id,visibility),check(read_seq>=0 and latest_seq>=read_seq)
);
create table public.support_operations(
  actor_user_id uuid not null references public.platform_users(id),request_id uuid not null,
  ticket_id uuid not null references public.support_tickets(id),fingerprint text not null,
  created_at timestamptz not null default now(),primary key(actor_user_id,request_id)
);
alter table public.support_entries enable row level security;
alter table public.support_notifications enable row level security;
alter table public.support_operations enable row level security;
revoke all on public.support_entries,public.support_notifications,public.support_operations from public,anon,authenticated,service_role;
revoke insert,update,delete on public.support_tickets from authenticated;
drop policy "Soro staff can update organization support tickets" on public.support_tickets;
drop policy "Soro staff can read organization support tickets" on public.support_tickets;
drop policy "Users can read their own organization support tickets" on public.support_tickets;

create function private.support_role_team(p_role public.platform_role) returns text
language sql immutable set search_path=pg_catalog as $$
select case when p_role in ('sales','sales_management') then 'sales' when p_role='talent_management' then 'talent_management' when p_role='admin' then 'admin' end;
$$;
create function private.support_staff(a public.platform_users,t public.support_tickets) returns boolean
language sql stable set search_path=pg_catalog,private as $$
select coalesce(a.organization_id=t.organization_id and a.active and not a.must_change_password
  and (a.role='admin' or private.support_role_team(a.role)=t.team),false);
$$;
create function private.support_can_read(p_actor_user_id uuid,p_ticket_id uuid) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;t public.support_tickets%rowtype;
begin
  select * into a from private.active_support_actor(p_actor_user_id);
  select * into t from public.support_tickets where id=p_ticket_id and organization_id=a.organization_id;
  return coalesce(found and (t.requester_user_id=a.id or private.support_staff(a,t)),false);
exception when insufficient_privilege then return false;
end $$;
revoke all on function private.support_role_team(public.platform_role),private.support_staff(public.platform_users,public.support_tickets),private.support_can_read(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function private.support_can_read(uuid,uuid) to authenticated;
create policy "Scoped support ticket reads" on public.support_tickets for select to authenticated using(private.support_can_read(auth.uid(),id));

create function private.support_route_ticket() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
  new.team:=case when new.area='Talent profiles and documents' then 'talent_management'
    when new.area in ('Sales, services and client accounts','Client records and placements') then 'sales' else 'admin' end;
  new.assigned_to_user_id:=null;
  if new.team='sales' then
    select u.id into new.assigned_to_user_id from public.client_portal_memberships m
    join public.clients c on c.id=m.client_id and c.organization_id=m.organization_id and c.archived_at is null
    join public.client_contacts cc on cc.id=m.client_contact_id and cc.client_id=c.id and cc.organization_id=c.organization_id and cc.active
    join public.platform_users u on u.id=c.sales_owner_id and u.organization_id=c.organization_id and u.active and not u.must_change_password and u.role in ('sales','sales_management')
    where m.user_id=new.requester_user_id and m.organization_id=new.organization_id and m.active
    order by c.id limit 1;
  end if;
  return new;
end $$;
create trigger support_route_ticket before insert on public.support_tickets for each row execute function private.support_route_ticket();

-- Extend only the event type/payload constraints; keep all dispatch safeguards.
do $$ declare c record;begin
  for c in select conname from pg_constraint where conrelid='public.confirmation_outbox'::regclass and contype='c' and (pg_get_constraintdef(oid) like '%event_type%' or pg_get_constraintdef(oid) like '%payload%') loop
    execute format('alter table public.confirmation_outbox drop constraint %I',c.conname);
  end loop;
end $$;
alter table public.confirmation_outbox add constraint confirmation_event_type check(event_type in ('support_ticket_created','client_profile_updated','support_ticket_reply','support_ticket_resolved','support_ticket_assigned')),
  add constraint confirmation_safe_payload check((event_type='client_profile_updated' and payload='{}'::jsonb) or(event_type in ('support_ticket_created','support_ticket_reply','support_ticket_resolved','support_ticket_assigned') and payload ? 'ticketNumber' and payload-'ticketNumber'='{}'::jsonb and jsonb_typeof(payload->'ticketNumber')='string' and payload->>'ticketNumber' ~ '^SUP-[A-F0-9]{8}$'));

create function private.support_notify(p_entry_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare e public.support_entries%rowtype;t public.support_tickets%rowtype;u public.platform_users%rowtype;v_email_type text;
begin
 select * into e from public.support_entries where id=p_entry_id;
 select * into t from public.support_tickets where id=e.ticket_id;
 for u in select a.* from public.platform_users a where a.organization_id=t.organization_id and a.active and not a.must_change_password and a.id<>e.actor_user_id
   and ((e.visibility='public' and e.kind<>'created' and a.id=t.requester_user_id)
     or (private.support_staff(a,t) and (a.id=t.assigned_to_user_id or(t.assigned_to_user_id is null and private.support_role_team(a.role)=t.team)))) loop
   if private.support_can_read(u.id,t.id) is not true then continue;end if;
   insert into public.support_notifications(ticket_id,recipient_user_id,visibility,latest_seq) values(t.id,u.id,e.visibility,e.seq)
   on conflict(ticket_id,recipient_user_id,visibility) do update set latest_seq=excluded.latest_seq;
   v_email_type:=case when e.kind='reply' then 'support_ticket_reply' when e.kind='status' and e.status='resolved' and u.id=t.requester_user_id then 'support_ticket_resolved' when e.kind in ('created','assignment') then 'support_ticket_assigned' end;
   if v_email_type is not null and (u.id=t.requester_user_id or u.id=t.assigned_to_user_id) then perform private.enqueue_confirmation(v_email_type,e.id,t.organization_id,u.id,jsonb_build_object('ticketNumber',t.ticket_number));end if;
 end loop;
end $$;
create function private.support_created_entry() returns trigger
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare e uuid;
begin insert into public.support_entries(ticket_id,actor_user_id,kind,visibility) values(new.id,new.requester_user_id,'created','public') returning id into e;
  perform private.support_notify(e);return new;
end $$;
create trigger support_created_entry after insert on public.support_tickets for each row execute function private.support_created_entry();

-- Preserve the proven retry/image/receipt implementation and expand categories.
do $$ declare f text;begin
 f:=pg_get_functiondef('public.create_support_ticket(uuid,uuid,text,text,text,text,text,integer)'::regprocedure);
 if position('''Other technical issue'')' in f)=0 then raise exception 'Support creation contract changed';end if;
 f:=replace(f,'''Other technical issue'')','''Other technical issue'',''Sales, services and client accounts'',''Billing and administrative questions'')');
 execute f;
end $$;

-- Activity is viewer-specific: private notes and assignments must not reorder
-- requester inboxes or change their visible timestamps/message previews.
create function private.support_visible_activity(t public.support_tickets,a public.platform_users) returns timestamptz
language sql stable security definer set search_path=pg_catalog,public,private as $$
 select coalesce(max(e.created_at),t.created_at) from public.support_entries e
 where e.ticket_id=t.id and(e.visibility='public' or private.support_staff(a,t));
$$;
revoke all on function private.support_visible_activity(public.support_tickets,public.platform_users) from public,anon,authenticated,service_role;

create function private.support_ticket_json(t public.support_tickets,a public.platform_users,p_detail boolean default false) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare r jsonb;staff boolean:=private.support_staff(a,t);manager boolean;entries jsonb;roster jsonb;latest_message jsonb;
begin
 manager:=coalesce(staff and (a.role='admin' or t.assigned_to_user_id=a.id),false);
 select jsonb_build_object('body',left(e.body,240),'visibility',e.visibility,'authorName',coalesce(u.display_name,'Soro')) into latest_message
 from public.support_entries e left join public.platform_users u on u.id=e.actor_user_id
 where e.ticket_id=t.id and e.kind in('reply','note') and(e.visibility='public' or staff) order by e.seq desc limit 1;
 r:=jsonb_build_object('ticketId',t.id,'ticketNumber',t.ticket_number,'subject',t.subject,'area',t.area,'details',t.details,'status',t.status,'createdAt',t.created_at,'team',t.team,'version',t.version,
 'lastActivityAt',private.support_visible_activity(t,a),'lastMessage',latest_message,'canReadInternal',staff,
 'assigneeId',t.assigned_to_user_id,'assigneeName',(select display_name from public.platform_users where id=t.assigned_to_user_id),
 'requesterName',(select display_name from public.platform_users where id=t.requester_user_id),'hasImage',t.image_storage_path is not null,
 'unread',exists(select 1 from public.support_notifications n where n.ticket_id=t.id and n.recipient_user_id=a.id and n.latest_seq>n.read_seq and (n.visibility='public' or staff)));
 if p_detail then
  select coalesce(jsonb_agg(jsonb_build_object('id',e.id,'seq',e.seq,'kind',e.kind,'visibility',e.visibility,'body',e.body,'status',e.status,'team',e.team,'assigneeName',(select display_name from public.platform_users where id=e.assignee_user_id),'authorName',coalesce(u.display_name,'Soro'),'createdAt',e.created_at) order by e.seq),'[]'::jsonb) into entries
  from public.support_entries e left join public.platform_users u on u.id=e.actor_user_id where e.ticket_id=t.id and (e.visibility='public' or staff);
  if a.role='admin' then select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',coalesce(u.display_name,'Soro employee'),'team',private.support_role_team(u.role)) order by u.display_name,u.id),'[]'::jsonb) into roster from public.platform_users u where u.organization_id=a.organization_id and u.active and not u.must_change_password and private.support_role_team(u.role) is not null;end if;
  r:=r||jsonb_build_object('entries',entries,'seenEntryId',(select coalesce(max(seq),0) from public.support_entries where ticket_id=t.id and (visibility='public' or staff)),
    'isAdmin',a.role='admin','canReadInternal',staff,'canManage',manager,'canClaim',staff and t.assigned_to_user_id is null,'canReply',manager or a.id=t.requester_user_id,'canNote',manager,'assignees',coalesce(roster,'[]'::jsonb));
 end if;
 return r;
end $$;
create or replace function public.get_support_tickets(p_actor_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;r jsonb;
begin
 select * into a from private.active_support_actor(p_actor_user_id);
 select coalesce(jsonb_agg(private.support_ticket_json(t,a) order by private.support_visible_activity(t,a) desc,t.id),'[]'::jsonb) into r from (select s.* from public.support_tickets s where private.support_can_read(a.id,s.id) order by private.support_visible_activity(s,a) desc,s.id limit 100) t;
 return jsonb_build_object('tickets',r,'internal',private.support_role_team(a.role) is not null,'team',private.support_role_team(a.role),'isAdmin',a.role='admin','hasMore',(select count(*)>100 from public.support_tickets s where private.support_can_read(a.id,s.id)));
end $$;
create function public.get_support_ticket(p_actor_user_id uuid,p_ticket_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;t public.support_tickets%rowtype;
begin select * into a from private.active_support_actor(p_actor_user_id);
 if private.support_can_read(a.id,p_ticket_id) is not true then raise exception using errcode='42501',message='Ticket unavailable.';end if;
 select * into t from public.support_tickets where id=p_ticket_id;return private.support_ticket_json(t,a,true);
end $$;
create function public.list_support_tickets(p_actor_user_id uuid,p_offset integer default 0,p_status text default '',p_team text default '',p_assignment text default '') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;r jsonb;total integer;summary jsonb;
begin
 select * into a from private.active_support_actor(p_actor_user_id);
 if p_offset is null or p_offset<0 or p_offset>1000000 or p_status is null or p_status not in ('','open','in_progress','waiting_on_client','resolved') or p_team is null or p_team not in ('','admin','sales','talent_management') or p_assignment is null or p_assignment not in ('','mine','unassigned') then raise exception using errcode='22023',message='Invalid ticket filters.';end if;
 -- Summary follows queue/assignment scope but intentionally ignores the status
 -- filter, so its status shortcuts remain meaningful and are not page-limited.
 select jsonb_build_object('open',count(*) filter(where s.status='open'),'in_progress',count(*) filter(where s.status='in_progress'),'waiting_on_client',count(*) filter(where s.status='waiting_on_client'),'resolved',count(*) filter(where s.status='resolved')) into summary
 from public.support_tickets s where private.support_can_read(a.id,s.id) and(p_team='' or s.team=p_team) and(p_assignment='' or(p_assignment='mine' and s.assigned_to_user_id=a.id) or(p_assignment='unassigned' and s.assigned_to_user_id is null));
 select count(*)::integer into total from public.support_tickets s where private.support_can_read(a.id,s.id) and (p_status='' or s.status=p_status) and(p_team='' or s.team=p_team) and(p_assignment='' or(p_assignment='mine' and s.assigned_to_user_id=a.id) or(p_assignment='unassigned' and s.assigned_to_user_id is null));
 select coalesce(jsonb_agg(private.support_ticket_json(t,a) order by private.support_visible_activity(t,a) desc,t.id),'[]'::jsonb) into r from(select s.* from public.support_tickets s where private.support_can_read(a.id,s.id) and(p_status='' or s.status=p_status) and(p_team='' or s.team=p_team) and(p_assignment='' or(p_assignment='mine' and s.assigned_to_user_id=a.id) or(p_assignment='unassigned' and s.assigned_to_user_id is null)) order by private.support_visible_activity(s,a) desc,s.id limit 50 offset p_offset)t;
 return jsonb_build_object('tickets',r,'summary',summary,'internal',private.support_role_team(a.role) is not null,'team',private.support_role_team(a.role),'isAdmin',a.role='admin','hasMore',total>p_offset+50,'offset',p_offset,'total',total);
end $$;
-- Replace the former organization-wide screenshot authorization in place.
do $$ declare f text;begin
 f:=pg_get_functiondef('public.get_support_ticket_image(uuid,uuid)'::regprocedure);
 if position('(s.requester_user_id=a.id or a.role in (' in f)=0 then raise exception 'Screenshot contract changed';end if;
 f:=replace(f,'(s.requester_user_id=a.id or a.role in (''admin'',''sales_management'',''sales'',''talent_management'',''billing''))','private.support_can_read(a.id,s.id)');execute f;
end $$;

create function public.get_support_notifications(p_actor_user_id uuid) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;n integer;
begin select * into a from private.active_support_actor(p_actor_user_id);
 select count(distinct n.ticket_id)::integer into n from public.support_notifications n join public.support_tickets t on t.id=n.ticket_id where n.recipient_user_id=a.id and n.latest_seq>n.read_seq and private.support_can_read(a.id,n.ticket_id) and (n.visibility='public' or private.support_staff(a,t));
 return jsonb_build_object('unread',n);
end $$;

create function public.update_support_ticket(p_actor_user_id uuid,p_ticket_id uuid,p_change jsonb) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;t public.support_tickets%rowtype;o public.support_operations%rowtype;
 action text:=p_change->>'action';v_request_id uuid;fingerprint text;e uuid;v_assignee uuid;v_team text;v_status text;v_body text;staff boolean;manager boolean;seen integer;
begin
 select * into a from private.active_support_actor(p_actor_user_id);
 if private.support_can_read(a.id,p_ticket_id) is not true then raise exception using errcode='42501',message='Ticket unavailable.';end if;
 if jsonb_typeof(p_change) is distinct from 'object' or action is null or action not in ('read','reply','note','status','claim','assign') then raise exception using errcode='22023',message='Invalid action.';end if;
 -- No caller-supplied organization, author, visibility, recipient, or path.
 if exists(select 1 from jsonb_object_keys(p_change) k where k not in ('action','ticketId','requestId','expectedVersion','seenEntryId','body','status','team','assigneeId')) then raise exception using errcode='22023',message='Invalid fields.';end if;
 select * into t from public.support_tickets where id=p_ticket_id for update;
 select * into a from private.active_support_actor(p_actor_user_id);
 if private.support_can_read(a.id,t.id) is not true then raise exception using errcode='42501',message='Ticket unavailable.';end if;
 staff:=private.support_staff(a,t);manager:=coalesce(staff and (a.role='admin' or t.assigned_to_user_id=a.id),false);
 if action='read' then
  seen:=(p_change->>'seenEntryId')::integer;
  if seen is null or seen<0 or seen>coalesce((select max(seq) from public.support_entries where ticket_id=t.id and(visibility='public' or staff)),0) then raise exception using errcode='22023',message='Invalid read cursor.';end if;
  update public.support_notifications set read_seq=greatest(read_seq,least(latest_seq,seen)) where ticket_id=t.id and recipient_user_id=a.id and (visibility='public' or staff);
  return jsonb_build_object('ticketId',t.id);
 end if;
 v_request_id:=(p_change->>'requestId')::uuid;
 if v_request_id is null then raise exception using errcode='22023',message='Request ID required.';end if;
 fingerprint:=encode(extensions.digest(convert_to(jsonb_build_object('ticket',t.id,'change',p_change)::text,'UTF8'),'sha256'),'hex');
 perform pg_advisory_xact_lock(hashtextextended('support-op:'||a.id::text||':'||v_request_id::text,0));
 select * into o from public.support_operations where actor_user_id=a.id and request_id=v_request_id;
 if found then if o.ticket_id<>t.id or o.fingerprint<>fingerprint then raise exception using errcode='23505',message='Request changed.';end if;return jsonb_build_object('ticketId',t.id);end if;
 if (p_change->>'expectedVersion')::integer is distinct from t.version then raise exception using errcode='40001',message='Ticket changed. Refresh before saving.';end if;
 if action in ('reply','note') then
  if (manager or(action='reply' and a.id=t.requester_user_id)) is not true then raise exception using errcode='42501',message='Assign this ticket to yourself before responding.';end if;
  v_body:=nullif(btrim(p_change->>'body'),'');if v_body is null or char_length(v_body)>5000 then raise exception using errcode='22023',message='Message required.';end if;
  insert into public.support_entries(ticket_id,actor_user_id,kind,visibility,body) values(t.id,a.id,action,case when action='note' then 'internal' else 'public' end,v_body) returning id into e;
  if action='reply' and a.id=t.requester_user_id and t.status in ('waiting_on_client','resolved') then
   update public.support_tickets set status='in_progress' where id=t.id;
   insert into public.support_entries(ticket_id,actor_user_id,kind,visibility,status) values(t.id,a.id,'status','public','in_progress');
  end if;
 elsif action='status' then
  if manager is not true then raise exception using errcode='42501',message='Ticket owner or Admin required.';end if;
  v_status:=p_change->>'status';if v_status is null or v_status not in ('open','in_progress','waiting_on_client','resolved') then raise exception using errcode='22023',message='Invalid status.';end if;
  if v_status<>t.status then update public.support_tickets set status=v_status where id=t.id;
   insert into public.support_entries(ticket_id,actor_user_id,kind,visibility,status) values(t.id,a.id,'status','public',v_status) returning id into e;end if;
 else
  if action='claim' then
   if staff is not true or t.assigned_to_user_id is not null then raise exception using errcode='42501',message='Ticket is not available to claim.';end if;
   v_assignee:=a.id;v_team:=t.team;
  else
   if a.role<>'admin' then raise exception using errcode='42501',message='Admin access required.';end if;
   v_assignee:=nullif(p_change->>'assigneeId','')::uuid;v_team:=p_change->>'team';
   if v_team is null or v_team not in ('sales','talent_management','admin') then raise exception using errcode='22023',message='Invalid queue.';end if;
  end if;
  if v_assignee is not null and not exists(select 1 from public.platform_users u where u.id=v_assignee and u.organization_id=a.organization_id and u.active and not u.must_change_password and (private.support_role_team(u.role)=v_team or u.role='admin')) then raise exception using errcode='22023',message='Eligible employee required.';end if;
  if v_team is distinct from t.team or v_assignee is distinct from t.assigned_to_user_id then
   update public.support_tickets set team=v_team,assigned_to_user_id=v_assignee where id=t.id;
   insert into public.support_entries(ticket_id,actor_user_id,kind,visibility,team,assignee_user_id) values(t.id,a.id,'assignment','internal',v_team,v_assignee) returning id into e;
  end if;
 end if;
 if e is not null then update public.support_tickets set version=version+1 where id=t.id;perform private.support_notify(e);end if;
 insert into public.support_operations(actor_user_id,request_id,ticket_id,fingerprint) values(a.id,v_request_id,t.id,fingerprint);
 return jsonb_build_object('ticketId',t.id);
end $$;

-- Queued ticket messages are rechecked against current membership/team access
-- at both claim and final prepare; transfers or account revocation stop mail.
create function private.support_confirmation_allowed(q public.confirmation_outbox) returns boolean
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare ticket uuid;
begin
 if q.event_type='client_profile_updated' then perform private.active_support_actor(q.recipient_user_id);return true;end if;
 if q.event_type='support_ticket_created' then ticket:=q.source_id;
 else select ticket_id into ticket from public.support_entries where id=q.source_id;end if;
 return ticket is not null and private.support_can_read(q.recipient_user_id,ticket);
exception when insufficient_privilege then return false;
end $$;
do $$ declare f text;name text;begin
 foreach name in array array['public.claim_confirmation_outbox(integer)','public.prepare_confirmation(uuid,uuid,text)'] loop
  f:=pg_get_functiondef(name::regprocedure);
  if position('if not exists(select 1 from public.platform_users' in f)=0 then raise exception 'Confirmation guard contract changed';end if;
  f:=replace(f,'if not exists(select 1 from public.platform_users','if not private.support_confirmation_allowed(q) or not exists(select 1 from public.platform_users');execute f;
 end loop;
end $$;
-- Every helper remains inaccessible as a standalone client/service operation.
revoke all on function private.support_route_ticket(),private.support_notify(uuid),private.support_created_entry(),private.support_ticket_json(public.support_tickets,public.platform_users,boolean),private.support_confirmation_allowed(public.confirmation_outbox) from public,anon,authenticated,service_role;
revoke all on function public.get_support_ticket(uuid,uuid),public.get_support_notifications(uuid),public.update_support_ticket(uuid,uuid,jsonb),public.list_support_tickets(uuid,integer,text,text,text) from public,anon,authenticated;
grant execute on function public.get_support_ticket(uuid,uuid),public.get_support_notifications(uuid),public.update_support_ticket(uuid,uuid,jsonb),public.list_support_tickets(uuid,integer,text,text,text) to service_role;
commit;
