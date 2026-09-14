-- Optional, private Dream photos and explicit placement-specific sharing.
begin;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('soro-dream-inspiration','soro-dream-inspiration',false,3145728,array['image/jpeg','image/png','image/webp']);
create table private.dream_inspiration_files(
 id uuid primary key,applicant_id uuid not null references public.applicants(id),organization_id uuid not null references public.organizations(id),
 uploaded_by uuid not null references public.platform_users(id),sha256 text not null check(sha256~'^[0-9a-f]{64}$'),
 type text not null check(type in('image/png','image/jpeg','image/webp')),size integer not null check(size between 1 and 3145728),
 path text not null unique,state text not null default 'pending' check(state in('pending','ready')),expected_version integer not null,
 caption text not null default '' check(length(caption)<=500),created_at timestamptz not null default clock_timestamp()
);
create table private.dream_inspirations(
 applicant_id uuid primary key references public.applicants(id),organization_id uuid not null references public.organizations(id),
 photo_id uuid references private.dream_inspiration_files(id),caption text not null default '' check(length(caption)<=500),version integer not null default 0
);
create table private.dream_inspiration_shares(
 placement_id uuid primary key references public.placements(id),client_id uuid not null references public.clients(id),applicant_id uuid not null references public.applicants(id),organization_id uuid not null references public.organizations(id),
 story text not null default '',photo_id uuid references private.dream_inspiration_files(id),caption text not null default '',
 active boolean not null default false,consent_note text not null,recorded_by uuid not null references public.platform_users(id),updated_at timestamptz not null default clock_timestamp()
);
create table private.dream_inspiration_history(id bigint generated always as identity primary key,applicant_id uuid not null references public.applicants(id),actor_id uuid not null references public.platform_users(id),action text not null,created_at timestamptz not null default clock_timestamp());
alter table private.dream_inspiration_files enable row level security;
alter table private.dream_inspirations enable row level security;
alter table private.dream_inspiration_shares enable row level security;
alter table private.dream_inspiration_history enable row level security;
revoke all on private.dream_inspiration_files,private.dream_inspirations,private.dream_inspiration_shares,private.dream_inspiration_history from public,anon,authenticated;

create function private.dream_client_allowed(a public.platform_users,p public.placements) returns boolean language sql stable security definer set search_path=pg_catalog,public,private as $$
 select a.role in('client_admin','client_reviewer') and private.work_log_current(p) and private.work_log_can_read(a,p)
$$;
create function public.get_dream_inspiration(p_actor_user_id uuid,p_applicant_id uuid,p_shared boolean default false) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;t public.applicants;i private.dream_inspirations;consent private.dream_inspiration_shares;choices jsonb;
begin
 a:=private.dc_actor(p_actor_user_id);
 if p_shared then
  if a.role not in('client_admin','client_reviewer') then raise exception using errcode='42501';end if;
  if not exists(select 1 from public.placements p where p.applicant_id=p_applicant_id and private.dream_client_allowed(a,p)) then raise exception using errcode='42501';end if;
  select x.* into consent from private.dream_inspiration_shares x join public.placements p on p.id=x.placement_id and p.client_id=x.client_id and p.applicant_id=x.applicant_id and p.organization_id=x.organization_id where x.applicant_id=p_applicant_id and x.organization_id=a.organization_id and x.active and private.dream_client_allowed(a,p) order by x.updated_at desc limit 1;
  if not found then return jsonb_build_object('shared',false);end if;
  return jsonb_build_object('shared',true,'story',consent.story,'photoId',consent.photo_id,'caption',consent.caption);
 end if;
 t:=private.dream_applicant(a.id,p_applicant_id);select * into i from private.dream_inspirations where applicant_id=t.id;
 select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'clientId',p.client_id,'clientName',c.company_name,'shareDream',coalesce(s.active and s.story<>'',false),'sharePhoto',coalesce(s.active and s.photo_id is not null,false),'sharedStory',case when s.active then s.story else '' end) order by p.id),'[]') into choices
 from (select distinct on(client_id) * from public.placements where applicant_id=t.id and private.work_log_current(placements) order by client_id,id) p join public.clients c on c.id=p.client_id and c.organization_id=t.organization_id
 left join lateral(select x.* from private.dream_inspiration_shares x join public.placements linked on linked.id=x.placement_id and linked.client_id=x.client_id and linked.applicant_id=x.applicant_id and linked.organization_id=x.organization_id where x.applicant_id=t.id and x.client_id=p.client_id and x.active and private.work_log_current(linked) order by x.updated_at desc limit 1) s on true;
 return jsonb_build_object('applicantId',t.id,'story',coalesce(t.greatest_dream,''),'photoId',i.photo_id,'caption',coalesce(i.caption,''),'version',coalesce(i.version,0),'canUpload',a.role='virtual_assistant','canShare',true,'self',a.role='virtual_assistant','placements',choices);
end $$;

create function public.change_dream_inspiration(p_actor_user_id uuid,p_body jsonb) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;t public.applicants;i private.dream_inspirations;f private.dream_inspiration_files;p public.placements;act text:=p_body->>'action';aid uuid:=(p_body->>'applicantId')::uuid;fid uuid:=(p_body->>'requestId')::uuid;ext text;share_story boolean;share_photo boolean;
begin
 a:=private.dc_actor(p_actor_user_id);t:=private.dream_applicant(a.id,aid);
 perform pg_advisory_xact_lock(hashtextextended('dream-inspiration:'||aid,0));
 perform 1 from public.applicants where id=aid for share;t:=private.dream_applicant(a.id,aid);
 insert into private.dream_inspirations(applicant_id,organization_id) values(t.id,t.organization_id) on conflict do nothing;
 select * into i from private.dream_inspirations where applicant_id=t.id for update;
 if act in('reserve','finalize','remove','caption') and a.role<>'virtual_assistant' then raise exception using errcode='42501';end if;
 if act='reserve' then
  select * into f from private.dream_inspiration_files where id=fid;
  if found then
   if f.uploaded_by<>a.id or f.applicant_id<>aid or f.sha256<>p_body->>'sha256' or f.type<>p_body->>'type' or f.size<>(p_body->>'size')::int or f.caption<>p_body->>'caption' then raise exception using errcode='23505';end if;
   return jsonb_build_object('id',f.id,'path',f.path,'state',f.state);
  end if;
 end if;
 if act='finalize' then
  select * into f from private.dream_inspiration_files where id=fid and applicant_id=aid and uploaded_by=a.id for update;
  if not found then raise exception using errcode='42501';end if;
  if f.state='ready' then return public.get_dream_inspiration(a.id,aid);end if;
  if f.created_at<clock_timestamp()-interval '1 hour' or f.expected_version<>i.version then raise exception using errcode='40001';end if;
 else
  if (p_body->>'version')::int is distinct from i.version then raise exception using errcode='40001';end if;
 end if;
 if act='reserve' then
  if (select count(*) from private.dream_inspiration_files where uploaded_by=a.id and created_at>clock_timestamp()-interval '1 day')>=10 then raise exception using errcode='P0001';end if;
  ext:=case p_body->>'type' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' when 'image/webp' then 'webp' end;
  if ext is null or fid is null then raise exception using errcode='22023';end if;
  insert into private.dream_inspiration_files(id,applicant_id,organization_id,uploaded_by,sha256,type,size,path,expected_version,caption) values(fid,aid,t.organization_id,a.id,p_body->>'sha256',p_body->>'type',(p_body->>'size')::int,t.organization_id||'/'||aid||'/'||fid||'.'||ext,i.version,p_body->>'caption') returning * into f;
  return jsonb_build_object('id',f.id,'path',f.path,'state',f.state);
 elsif act='finalize' then
  update private.dream_inspiration_files set state='ready' where id=f.id;
  update private.dream_inspirations set photo_id=f.id,caption=f.caption,version=version+1 where applicant_id=aid;
  -- A new photo is never automatically shared under an older consent.
  update private.dream_inspiration_shares set photo_id=null,caption='',active=story<>'' where applicant_id=aid;
 elsif act='remove' then
  update private.dream_inspirations set photo_id=null,caption='',version=version+1 where applicant_id=aid;
  update private.dream_inspiration_shares set photo_id=null,caption='',active=story<>'' where applicant_id=aid;
 elsif act='caption' then
  update private.dream_inspirations set caption=p_body->>'caption',version=version+1 where applicant_id=aid;
  update private.dream_inspiration_shares set photo_id=null,caption='',active=story<>'' where applicant_id=aid;
 elsif act='share' then
  select * into p from public.placements where id=(p_body->>'placementId')::uuid and applicant_id=aid and organization_id=t.organization_id for share;
  if not found or not private.work_log_current(p) or p.client_id is distinct from (p_body->>'clientId')::uuid then raise exception using errcode='42501';end if;
  share_story:=coalesce((p_body->>'shareDream')::boolean,false);share_photo:=coalesce((p_body->>'sharePhoto')::boolean,false);
  if share_story and p_body->>'approvedStory' is distinct from t.greatest_dream then raise exception using errcode='40001';end if;
  if length(btrim(coalesce(p_body->>'consentNote',''))) not between 1 and 500 or (share_photo and i.photo_id is null) or (share_story and nullif(btrim(t.greatest_dream),'') is null) then raise exception using errcode='22023';end if;
  -- One coherent sharing choice per Talent and Client, even with several placements.
  update private.dream_inspiration_shares set active=false where applicant_id=aid and client_id=p.client_id;
  insert into private.dream_inspiration_shares(placement_id,client_id,applicant_id,organization_id,story,photo_id,caption,active,consent_note,recorded_by)
  values(p.id,p.client_id,aid,t.organization_id,case when share_story then p_body->>'approvedStory' else '' end,case when share_photo then i.photo_id end,case when share_photo then i.caption else '' end,share_story or share_photo,p_body->>'consentNote',a.id)
  on conflict(placement_id) do update set client_id=excluded.client_id,applicant_id=excluded.applicant_id,organization_id=excluded.organization_id,story=excluded.story,photo_id=excluded.photo_id,caption=excluded.caption,active=excluded.active,consent_note=excluded.consent_note,recorded_by=a.id,updated_at=clock_timestamp();
  update private.dream_inspirations set version=version+1 where applicant_id=aid;
 else raise exception using errcode='22023';end if;
 insert into private.dream_inspiration_history(applicant_id,actor_id,action) values(aid,a.id,act);
 return public.get_dream_inspiration(a.id,aid);
end $$;

create function public.get_dream_inspiration_photo(p_actor_user_id uuid,p_photo_id uuid) returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users;f private.dream_inspiration_files;t public.applicants;
begin
 a:=private.dc_actor(p_actor_user_id);select * into f from private.dream_inspiration_files where id=p_photo_id and state='ready' and organization_id=a.organization_id;
 if not found then raise exception using errcode='42501';end if;
 if a.role in('client_admin','client_reviewer') then
  if not exists(select 1 from private.dream_inspiration_shares s join public.placements p on p.id=s.placement_id and p.client_id=s.client_id and p.applicant_id=s.applicant_id and p.organization_id=s.organization_id where s.photo_id=f.id and s.active and s.applicant_id=f.applicant_id and private.dream_client_allowed(a,p)) then raise exception using errcode='42501';end if;
 else
  t:=private.dream_applicant(a.id,f.applicant_id);
  if not exists(select 1 from private.dream_inspirations where applicant_id=t.id and photo_id=f.id) then raise exception using errcode='42501';end if;
 end if;
 return jsonb_build_object('path',f.path);
end $$;
create function private.revoke_dream_sharing_on_placement_change() returns trigger language plpgsql security definer set search_path=pg_catalog,public,private as $$
begin
 if old.client_id is distinct from new.client_id or old.applicant_id is distinct from new.applicant_id or old.organization_id is distinct from new.organization_id or not private.work_log_current(new) then
  update private.dream_inspiration_shares set active=false where placement_id=old.id;
 end if;
 return new;
end $$;
create trigger revoke_dream_sharing_on_placement_change after update on public.placements for each row execute function private.revoke_dream_sharing_on_placement_change();
revoke all on function private.revoke_dream_sharing_on_placement_change() from public,anon,authenticated;
revoke all on function private.dream_client_allowed(public.platform_users,public.placements),public.get_dream_inspiration(uuid,uuid,boolean),public.change_dream_inspiration(uuid,jsonb),public.get_dream_inspiration_photo(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_dream_inspiration(uuid,uuid,boolean),public.change_dream_inspiration(uuid,jsonb),public.get_dream_inspiration_photo(uuid,uuid) to service_role;
commit;
