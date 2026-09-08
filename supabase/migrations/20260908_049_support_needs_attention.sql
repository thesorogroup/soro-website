-- Follow-up projection plus private initial-owner metadata for future tickets.
-- No historical backfill, new notifications, SLA or role expansion.
begin;

alter table public.support_entries
  add column initial_owner_recorded boolean not null default false,
  add column initial_assignee_user_id uuid references public.platform_users(id);
-- These fields are not part of the public entry JSON allowlist. Existing
-- entry-table RLS/grants remain unchanged; do not expose historical ownership.
do $$ declare f text;needle text:='(ticket_id,actor_user_id,kind,visibility) values(new.id,new.requester_user_id,''created'',''public'')';begin
  f:=pg_get_functiondef('private.support_created_entry()'::regprocedure);
  if (length(f)-length(replace(f,needle,'')))/length(needle)<>1 then raise exception 'Support creation event contract changed';end if;
  f:=replace(f,needle,'(ticket_id,actor_user_id,kind,visibility,initial_owner_recorded,initial_assignee_user_id) values(new.id,new.requester_user_id,''created'',''public'',true,new.assigned_to_user_id)');
  execute f;
end $$;

create index support_public_reply_sequence_idx on public.support_entries(ticket_id,seq)
  where kind='reply' and visibility='public';

create function private.support_attention(t public.support_tickets) returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare last_soro integer;last_owned integer;initial_unassigned boolean;awaiting timestamptz;unassigned_at timestamptz;since_at timestamptz;
begin
  if t.status='resolved' then
    return jsonb_build_object('needsAttention',false,'unassigned',false,'awaitingReply',false,'awaitingSince',null,'unassignedSince',null,'since',null);
  end if;
  if t.status in ('open','in_progress') then
    -- The requester remains the requester even if they also have a staff role.
    -- Sequence, not timestamp or current author role, defines conversation order.
    select max(e.seq) into last_soro from public.support_entries e
      where e.ticket_id=t.id and e.kind='reply' and e.visibility='public' and e.actor_user_id<>t.requester_user_id;
    if last_soro is null then awaiting:=t.created_at;
    else
      select e.created_at into awaiting from public.support_entries e
        where e.ticket_id=t.id and e.kind='reply' and e.visibility='public'
          and e.actor_user_id=t.requester_user_id and e.seq>last_soro order by e.seq limit 1;
    end if;
  end if;
  if t.assigned_to_user_id is null then
    select max(e.seq) into last_owned from public.support_entries e
      where e.ticket_id=t.id and e.kind='assignment' and e.assignee_user_id is not null;
    select e.initial_owner_recorded and e.initial_assignee_user_id is null into initial_unassigned
      from public.support_entries e where e.ticket_id=t.id and e.kind='created' order by e.seq limit 1;
    if last_owned is null and initial_unassigned is true then unassigned_at:=t.created_at;
    else
      select e.created_at into unassigned_at from public.support_entries e
        where e.ticket_id=t.id and e.kind='assignment' and e.assignee_user_id is null and e.seq>coalesce(last_owned,0) order by e.seq limit 1;
      -- Legacy tickets lack initial-owner metadata. Use the first recorded
      -- release into a pool, or creation when no assignment history exists.
      unassigned_at:=coalesce(unassigned_at,t.created_at);
    end if;
  end if;
  since_at:=least(awaiting,unassigned_at);
  return jsonb_build_object('needsAttention',since_at is not null,'unassigned',unassigned_at is not null,
    'awaitingReply',awaiting is not null,'awaitingSince',awaiting,'unassignedSince',unassigned_at,'since',since_at);
end $$;
revoke all on function private.support_attention(public.support_tickets) from public,anon,authenticated,service_role;

-- Extend the existing projection only for authorized staff. Client and
-- other-team requester payloads must not expose assignment-derived timing.
do $$ declare f text;needle text:=' return r;';begin
  f:=pg_get_functiondef('private.support_ticket_json(public.support_tickets,public.platform_users,boolean)'::regprocedure);
  if (length(f)-length(replace(f,needle,'')))/length(needle)<>1 then raise exception 'Support projection contract changed';end if;
  f:=replace(f,needle,' if staff then r:=r||jsonb_build_object(''attention'',private.support_attention(t));end if;'||chr(10)||needle);
  execute f;
end $$;

create function public.list_support_workspace(p_actor_user_id uuid,p_offset integer default 0,p_status text default '',p_team text default '',p_assignment text default '',p_view text default 'all',p_reason text default '') returns jsonb
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;r jsonb;totals jsonb;items jsonb;n integer;
begin
  select * into a from private.active_support_actor(p_actor_user_id);
  if p_view is null or p_view not in ('all','attention') or p_reason is null or p_reason not in ('','unassigned','awaiting_reply')
    or (p_view='all' and p_reason<>'') or (p_view='attention' and p_status<>'') then
    raise exception using errcode='22023',message='Invalid ticket view.';
  end if;
  if p_view='attention' and private.support_role_team(a.role) is null then
    raise exception using errcode='42501',message='Team support access required.';
  end if;
  -- Retain established validation, status totals, requester scope and all-view order.
  r:=public.list_support_tickets(p_actor_user_id,p_offset,p_status,p_team,p_assignment);
  if private.support_role_team(a.role) is null then return r;end if;

  with scoped as materialized (
    select s as ticket,private.support_attention(s) as attention from public.support_tickets s
    where private.support_staff(a,s)
      and (p_team='' or s.team=p_team)
      and (p_assignment='' or(p_assignment='mine' and s.assigned_to_user_id=a.id) or(p_assignment='unassigned' and s.assigned_to_user_id is null))
  ), waiting as materialized (
    select *,case when p_reason='awaiting_reply' then (attention->>'awaitingSince')::timestamptz
      when p_reason='unassigned' then (attention->>'unassignedSince')::timestamptz
      else (attention->>'since')::timestamptz end as waiting_since
    from scoped where (attention->>'needsAttention')::boolean
      and (p_reason='' or(p_reason='unassigned' and (attention->>'unassigned')::boolean) or(p_reason='awaiting_reply' and (attention->>'awaitingReply')::boolean))
  ), page as (
    select * from waiting order by waiting_since,(ticket).id limit 50 offset p_offset
  )
  select (select jsonb_build_object('total',count(*) filter(where (attention->>'needsAttention')::boolean),
      'unassigned',count(*) filter(where (attention->>'unassigned')::boolean),
      'awaitingReply',count(*) filter(where (attention->>'awaitingReply')::boolean)) from scoped),
    (select count(*)::integer from waiting),
    (select coalesce(jsonb_agg(private.support_ticket_json(ticket,a)||jsonb_build_object('attention',attention||jsonb_build_object('since',waiting_since)) order by waiting_since,(ticket).id),'[]'::jsonb) from page)
    into totals,n,items;
  r:=r||jsonb_build_object('view',p_view,'attentionSummary',totals);
  if p_view='attention' then r:=r||jsonb_build_object('tickets',items,'total',n,'offset',p_offset,'hasMore',n>p_offset+50);end if;
  return r;
end $$;
revoke all on function public.list_support_workspace(uuid,integer,text,text,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.list_support_workspace(uuid,integer,text,text,text,text,text) to service_role;
commit;
