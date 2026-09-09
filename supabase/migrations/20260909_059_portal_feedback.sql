-- Private, organization-scoped product feedback. No sample data or email sends.
begin;
create table public.portal_feedback (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  author_user_id uuid not null,
  author_role public.platform_role not null,
  request_id uuid not null,
  category text not null check(category in ('suggestion','experience','general')),
  message text not null check(char_length(btrim(message)) between 3 and 4000),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid,
  foreign key(author_user_id,organization_id) references public.platform_users(id,organization_id),
  foreign key(reviewed_by,organization_id) references public.platform_users(id,organization_id),
  unique(author_user_id,request_id),
  check((reviewed_at is null)=(reviewed_by is null))
);
create index portal_feedback_org_created_idx on public.portal_feedback(organization_id,created_at desc,id desc);
create index portal_feedback_author_created_idx on public.portal_feedback(author_user_id,created_at desc,id desc);
alter table public.portal_feedback enable row level security;
revoke all on public.portal_feedback from public,anon,authenticated,service_role;

create function private.feedback_actor(p_actor_user_id uuid) returns public.platform_users
language plpgsql security definer set search_path=pg_catalog,public as $$
declare a public.platform_users%rowtype;
begin
  select * into a from public.platform_users where id=p_actor_user_id for share;
  if not found or a.active is not true or a.must_change_password is true or a.organization_id is null
    or a.role not in ('admin','sales','sales_management','talent_management','billing','client_admin','client_reviewer','client_billing','virtual_assistant') then
    raise exception using errcode='42501',message='Active portal account required.';
  end if;
  return a;
end $$;

create function public.submit_portal_feedback(p_actor_user_id uuid,p_request_id uuid,p_category text,p_message text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;f public.portal_feedback%rowtype;
begin
  select * into a from private.feedback_actor(p_actor_user_id);
  if p_request_id is null or p_category is null or p_category not in ('suggestion','experience','general')
    or p_message is null or char_length(btrim(p_message)) not between 3 and 4000 then
    raise exception using errcode='22023',message='Valid feedback required.';
  end if;
  p_message:=btrim(p_message);
  perform pg_advisory_xact_lock(hashtextextended('portal-feedback:'||a.id::text,0));
  select * into f from public.portal_feedback where author_user_id=a.id and request_id=p_request_id;
  if found then
    if f.organization_id<>a.organization_id or f.category<>p_category or f.message<>p_message then
      raise exception using errcode='23505',message='Submission changed.';
    end if;
    return jsonb_build_object('id',f.id);
  end if;
  if (select count(*) from public.portal_feedback where author_user_id=a.id and created_at>now()-interval '1 minute')>=5
    or (select count(*) from public.portal_feedback where author_user_id=a.id and created_at>now()-interval '1 day')>=25 then
    raise exception using errcode='P0001',message='feedback_rate_limit';
  end if;
  insert into public.portal_feedback(organization_id,author_user_id,author_role,request_id,category,message)
    values(a.organization_id,a.id,a.role,p_request_id,p_category,p_message) returning * into f;
  return jsonb_build_object('id',f.id);
end $$;

create function public.list_portal_feedback(p_actor_user_id uuid,p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;items jsonb;total integer;
begin
  select * into a from private.feedback_actor(p_actor_user_id);
  if p_offset is null or p_offset<0 or p_offset>1000000 then raise exception using errcode='22023',message='Invalid page.';end if;
  with page as (
    select f.*,u.display_name from public.portal_feedback f
    join public.platform_users u on u.id=f.author_user_id and u.organization_id=f.organization_id
    where f.organization_id=a.organization_id and (a.role='admin' or f.author_user_id=a.id)
    order by f.created_at desc,f.id desc limit 26 offset p_offset
  ), numbered as (select page.*,row_number() over(order by created_at desc,id desc) rn from page)
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'category',category,'message',message,'createdAt',created_at,
    'reviewedAt',reviewed_at,'authorName',case when a.role='admin' then display_name end,
    'authorRole',case when a.role='admin' then author_role::text end) order by created_at desc,id desc) filter(where rn<=25),'[]'::jsonb),count(*)
    into items,total from numbered;
  return jsonb_build_object('items',items,'canReview',a.role='admin','hasMore',total>25);
end $$;

create function public.review_portal_feedback(p_actor_user_id uuid,p_feedback_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype;f public.portal_feedback%rowtype;
begin
  select * into a from private.feedback_actor(p_actor_user_id);
  if a.role<>'admin' then raise exception using errcode='42501',message='Admin access required.';end if;
  select * into f from public.portal_feedback where id=p_feedback_id and organization_id=a.organization_id for update;
  if not found then raise exception using errcode='42501',message='Feedback unavailable.';end if;
  if f.reviewed_at is null then update public.portal_feedback set reviewed_at=now(),reviewed_by=a.id where id=f.id;end if;
  return jsonb_build_object('id',f.id);
end $$;
revoke all on function private.feedback_actor(uuid) from public,anon,authenticated,service_role;
revoke all on function public.submit_portal_feedback(uuid,uuid,text,text),public.list_portal_feedback(uuid,integer),public.review_portal_feedback(uuid,uuid) from public,anon,authenticated;
grant execute on function public.submit_portal_feedback(uuid,uuid,text,text),public.list_portal_feedback(uuid,integer),public.review_portal_feedback(uuid,uuid) to service_role;
commit;
