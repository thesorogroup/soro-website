-- Read-only reporting over canonical operational records. No seed data, mutations,
-- new table grants, or browser-callable security-definer functions.
begin;

-- Keep lifecycle precedence aligned with sales-lifecycle-tracker. The existing
-- full, scoped aggregate is reused, without the HTTP tracker's 5,000-row cap.
create function private.report_sales_workflow(r jsonb) returns jsonb
language plpgsql immutable set search_path=pg_catalog as $$
declare s text; n text; attention text;
begin
 if r->>'status' in ('cancelled','on_hold') then s:=r->>'status';
 elsif (r->>'activePlacementCount')::int >= (r->>'seatCount')::int then s:='active';
 elsif (r->>'placementCount')::int >= (r->>'seatCount')::int then s:=case when (r->>'onboardingCount')::int>0 then 'onboarding' else 'placement' end;
 elsif (r->>'selectedCandidateCount')::int > (r->>'preparedHandoffCount')::int then s:='selection';
 elsif (r->>'preparedHandoffCount')::int>0 then s:='placement';
 elsif (r->>'interviewCount')::int>0 or (r->>'interviewRequestedCount')::int>0 or (r->>'interviewFollowUpCount')::int>0 or (r->>'calendarPendingCount')::int>0 then s:='interviewing';
 elsif (r->>'completedInterviewCount')::int>0 and (r->>'sentCandidateCount')::int>0 then s:='selection';
 elsif (r->>'sentCandidateCount')::int>0 then s:='client_review';
 elsif (r->>'draftCandidateCount')::int>0 or (r->>'placementCount')::int>0 then s:='matching';
 else s:=case r->>'status' when 'draft' then 'discovery' when 'discovery' then 'discovery' when 'open' then 'matching' when 'sourcing' then 'matching' when 'shortlisting' then 'matching' when 'client_review' then 'client_review' when 'interviewing' then 'interviewing' when 'selection_pending' then 'selection' when 'placement_pending' then 'placement' when 'partially_filled' then 'matching' when 'filled' then 'placement' else r->>'status' end; end if;
 n:=case s when 'discovery' then 'Complete client setup' when 'matching' then case when (r->>'draftCandidateCount')::int>0 then 'Review shortlist' else 'Find candidates' end when 'client_review' then 'Review shortlist' when 'interviewing' then 'Manage interviews' when 'selection' then case when (r->>'selectedCandidateCount')::int>(r->>'preparedHandoffCount')::int then 'Prepare handoff' else 'Review selection' end when 'placement' then 'View placement' when 'onboarding' then 'View onboarding' when 'active' then 'View placement' else 'Review client setup' end;
 if s not in ('active','on_hold','cancelled') then
  if r->>'ownerId' is null or not coalesce((r->>'ownerActive')::boolean,false) then attention:='owner_missing';
  elsif (r->>'activeContactCount')::int=0 then attention:='contact_missing';
  elsif (r->>'outcomeDueCount')::int>0 then attention:='interview_outcome_due';
  elsif (r->>'calendarIssueCount')::int>0 then attention:='calendar_sync_failed';
  elsif (s in ('client_review','interviewing') and (r->>'portalContactCount')::int=0) or (s='selection' and n='Review selection' and (r->>'portalDecisionContactCount')::int=0) then attention:=case when (r->>'portalIssueCount')::int>0 then 'portal_delivery_failed' else 'portal_access_needed' end;
  elsif coalesce((r->>'isTargetStartPast')::boolean,false) and (r->>'placementCount')::int<(r->>'seatCount')::int then attention:='start_date_passed'; end if;
 end if;
 if attention in ('owner_missing','contact_missing','portal_delivery_failed','portal_access_needed') then n:='Complete client setup';
 elsif attention in ('interview_outcome_due','calendar_sync_failed') then n:='Manage interviews'; end if;
 return jsonb_build_object('stage',s,'next',n,'attention',attention);
end $$;

create function private.operations_report_rows(p_actor_user_id uuid,p_report text)
returns table(id uuid,title text,detail text,status text,owner_id uuid,owner_name text,team text,areas text[],report_date date,end_date date,sort_at timestamptz,cells jsonb,href text,flags text[])
language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare a public.platform_users%rowtype; now_at timestamptz:=statement_timestamp(); today date:=(statement_timestamp() at time zone 'America/Chicago')::date;
begin
 perform 1 from private.task_actor(p_actor_user_id);
 select * into strict a from public.platform_users u where u.id=p_actor_user_id;
 if not ((p_report in ('sales','placements') and a.role in ('admin','sales','sales_management')) or (p_report in ('talent','attendance','time_off') and a.role in ('admin','talent_management')) or (p_report='support' and a.role in ('admin','sales','sales_management','talent_management')) or (p_report='documents' and a.role in ('admin','sales','sales_management','talent_management','billing'))) then
  raise exception 'Report access denied' using errcode='42501';
 end if;
 if p_report='sales' then
  return query
  select h.id,c.company_name,h.title,w.v->>'stage',c.sales_owner_id,u.display_name,'sales'::text,'{}'::text[],(h.created_at at time zone 'UTC')::date,null::date,h.created_at,
   jsonb_build_array(w.v->>'stage',u.display_name,w.v->>'next',h.start_date), '#client-placement/'||h.id,
   array_remove(array[case when w.v->>'stage' not in ('active','cancelled') then 'open' end,case when w.v->>'attention' is not null then 'attention' end],null)
  from jsonb_array_elements(public.get_sales_lifecycle_tracker(a.id)->'rows') raw(v)
  join public.hiring_requests h on h.id=(raw.v->>'requestId')::uuid and h.organization_id=a.organization_id
  join public.clients c on c.id=h.client_id and c.organization_id=a.organization_id and c.archived_at is null
  left join public.platform_users u on u.id=c.sales_owner_id and u.organization_id=a.organization_id
  cross join lateral (select private.report_sales_workflow(raw.v||jsonb_build_object('ownerActive',coalesce(private.is_sales_owner(u.id,a.organization_id),false))) v) w
  where a.role<>'sales' or c.sales_owner_id=a.id;
 elsif p_report='placements' then
  return query select p.id,c.company_name,t.full_name,p.status,c.sales_owner_id,u.display_name,'sales'::text,'{}'::text[],p.start_date,null::date,p.created_at,
   jsonb_build_array(p.status,u.display_name,p.start_date,p.end_date),case when p.hiring_request_id is not null then '#client-placement/'||p.hiring_request_id else '#client/'||c.id end,
   array_remove(array[case when p.end_date is null and p.status in ('placement_confirmed','onboarding') and p.start_date between today and today+14 then 'upcoming' end,case when p.end_date is null and p.status in ('placement_confirmed','onboarding') and p.start_date<today then 'attention' end],null)
  from public.placements p join public.clients c on c.id=p.client_id and c.organization_id=p.organization_id and c.archived_at is null
  join public.applicants t on t.id=p.applicant_id and t.organization_id=p.organization_id
  left join public.platform_users u on u.id=c.sales_owner_id and u.organization_id=p.organization_id
  where p.organization_id=a.organization_id and (a.role<>'sales' or c.sales_owner_id=a.id);
 elsif p_report='talent' then
  return query select t.id,t.full_name,nullif(array_to_string(t.self_reported_experience_areas,', '),''),case when t.archived_at is not null or t.status='not_selected' then 'closed' else t.status::text end,t.talent_review_owner_id,u.display_name,'talent_management'::text,coalesce(t.self_reported_experience_areas,'{}'),(d.received at time zone 'UTC')::date,null::date,d.received,
   jsonb_build_array(case when t.archived_at is not null or t.status='not_selected' then 'closed' else t.status::text end,u.display_name,(d.received at time zone 'UTC')::date,greatest(0,(now_at at time zone 'UTC')::date-(d.received at time zone 'UTC')::date)||' days'),
   case when t.archived_at is null then '#talent/'||t.id else '#talent-review' end,'{}'::text[]
  from public.applicants t left join public.platform_users u on u.id=t.talent_review_owner_id and u.organization_id=t.organization_id
  cross join lateral (select coalesce(t.application_received_at,t.submitted_at,t.created_at) received) d
  where t.organization_id=a.organization_id and t.status in ('submitted','in_review','needs_more_info','bench_ready','not_selected');
 elsif p_report='attendance' then
  return query select s.id,t.full_name,c.company_name,case when s.checked_out_at is null then 'open' else 'checked_out' end,coalesce(t.talent_support_owner_id,t.talent_review_owner_id),u.display_name,'talent_management'::text,'{}'::text[],s.work_date,null::date,s.started_at,
   jsonb_build_array(s.work_date||' · '||s.work_timezone,to_char(s.started_at at time zone s.work_timezone,'YYYY-MM-DD HH24:MI'),to_char(s.checked_out_at at time zone s.work_timezone,'YYYY-MM-DD HH24:MI'),case when s.checked_out_at is null then 'open' else 'checked_out' end),
   case when t.archived_at is null then '#talent/'||t.id else '#talent-review' end,
   array_remove(array[case when s.checked_out_at is null and s.work_date<(now_at at time zone s.work_timezone)::date then 'attention' end],null)
  from public.talent_attendance_sessions s join public.applicants t on t.id=s.applicant_id and t.organization_id=s.organization_id
  join public.placements p on p.id=s.placement_id and p.applicant_id=s.applicant_id and p.organization_id=s.organization_id
  join public.clients c on c.id=p.client_id and c.organization_id=s.organization_id
  left join public.platform_users u on u.id=coalesce(t.talent_support_owner_id,t.talent_review_owner_id) and u.organization_id=s.organization_id
  where s.organization_id=a.organization_id;
 elsif p_report='time_off' then
  return query select s.id,t.full_name,c.company_name,s.status,coalesce(t.talent_support_owner_id,t.talent_review_owner_id),u.display_name,'talent_management'::text,'{}'::text[],s.start_date,s.end_date,s.submitted_at,
   jsonb_build_array(s.start_date||' – '||s.end_date||' · '||s.work_timezone,s.status,to_char(s.submitted_at at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC',to_char(s.decided_at at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC'),
   '#overview','{}'::text[]
  from public.talent_time_off_requests s join public.applicants t on t.id=s.applicant_id and t.organization_id=s.organization_id
  join public.placements p on p.id=s.placement_id and p.applicant_id=s.applicant_id and p.organization_id=s.organization_id
  join public.clients c on c.id=p.client_id and c.organization_id=s.organization_id
  left join public.platform_users u on u.id=coalesce(t.talent_support_owner_id,t.talent_review_owner_id) and u.organization_id=s.organization_id
  where s.organization_id=a.organization_id;
 elsif p_report='support' then
  return query select t.id,'Ticket '||t.ticket_number,null::text,t.status,t.assigned_to_user_id,u.display_name,t.team,'{}'::text[],(t.created_at at time zone 'UTC')::date,null::date,t.created_at,
   jsonb_build_array(t.team||' · '||coalesce(u.display_name,'Unassigned'),t.status,to_char((att.v->>'since')::timestamptz at time zone 'UTC','YYYY-MM-DD HH24:MI')||' UTC',(t.created_at at time zone 'UTC')::date),'#help?ticketId='||t.id,
   array_remove(array[case when t.status<>'resolved' then 'open' end,case when (att.v->>'awaitingReply')::boolean then 'attention' end,case when (att.v->>'unassigned')::boolean then 'unassigned' end],null)
  from public.support_tickets t left join public.platform_users u on u.id=t.assigned_to_user_id and u.organization_id=t.organization_id
  cross join lateral (select private.support_attention(t) v) att
  where private.support_staff(a,t);
 elsif p_report='documents' then
  return query select r.id,r.title,u.display_name,r.status,r.created_by,creator.display_name,r.team,'{}'::text[],r.due_date,null::date,r.created_at,
   jsonb_build_array(r.team,r.status,r.due_date,counts.accepted||' / '||counts.visible), '#documents?requestId='||r.id,
   array_remove(array[case when r.due_date<today and r.status not in ('complete','cancelled') then 'overdue' end,case when counts.submitted>0 and r.status<>'cancelled' then 'ready' end],null)
  from public.dc_requests r
  join public.platform_users u on u.id=r.recipient_id and u.organization_id=r.organization_id
  left join public.platform_users creator on creator.id=r.created_by and creator.organization_id=r.organization_id
  cross join lateral(select count(*) visible,count(*) filter(where i.status='accepted') accepted,count(*) filter(where i.status='submitted') submitted
   from public.dc_items i join public.dc_templates t on t.id=i.template_id and t.organization_id=r.organization_id
   where i.request_id=r.id and private.dc_item_access(a,r,t) and (a.role<>'billing' or t.category='tax')) counts
  where r.organization_id=a.organization_id and private.dc_request_access(a,r) and private.dc_team_access(a,r) and (a.role<>'billing' or counts.visible>0);
 end if;
end $$;

create function public.get_operations_report(p_actor_user_id uuid,p_report text,p_filters jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public,private as $$
declare f jsonb:=p_filters; result jsonb; first_date date; last_date date; skip integer; actor_role text;
begin
 select role::text into actor_role from private.task_actor(p_actor_user_id);
 if f is null or jsonb_typeof(f)<>'object' or exists(select 1 from jsonb_object_keys(f) k where k not in ('search','status','owner','team','area','from','to','population','flag','offset')) or exists(select 1 from jsonb_each(f) e where jsonb_typeof(e.value)<>'string') or length(coalesce(f->>'search',''))>120 or length(coalesce(f->>'status',''))>80 or coalesce(f->>'offset','0')!~'^[0-9]{1,7}$' or coalesce(f->>'population','all') not in ('open','all') or coalesce(f->>'flag','') not in ('','attention','unassigned','upcoming','overdue','ready') then raise exception 'Invalid report filters' using errcode='22023';end if;
 if coalesce(f->>'owner','') not in ('','unassigned') and (f->>'owner')!~'^[0-9a-fA-F-]{36}$' then raise exception 'Invalid owner' using errcode='22023';end if;
 if coalesce(f->>'from','')<>'' and (f->>'from')!~'^\d{4}-\d{2}-\d{2}$' or coalesce(f->>'to','')<>'' and (f->>'to')!~'^\d{4}-\d{2}-\d{2}$' then raise exception 'Invalid dates' using errcode='22023';end if;
 first_date:=nullif(f->>'from','')::date;last_date:=nullif(f->>'to','')::date;skip:=coalesce(f->>'offset','0')::int;
 if first_date>last_date or skip>1000000 then raise exception 'Invalid report page or dates' using errcode='22023';end if;
 with authorized as materialized(select * from private.operations_report_rows(p_actor_user_id,p_report)),
 base as materialized(select * from authorized r where
  (coalesce(f->>'search','')='' or strpos(lower(r.title||' '||coalesce(r.detail,'')||' '||coalesce((select string_agg(case ar when 'healthcare' then 'medical healthcare' when 'general_admin' then 'general administration' when 'social_media' then 'social media digital marketing' when 'customer_support' then 'customer support' when 'ecommerce' then 'e-commerce ecommerce' else ar end,' ') from unnest(r.areas) ar),'')),lower(f->>'search'))>0)
  and (coalesce(f->>'owner','')='' or (f->>'owner'='unassigned' and r.owner_id is null) or r.owner_id::text=lower(f->>'owner'))
  and (coalesce(f->>'team','')='' or r.team=f->>'team') and (coalesce(f->>'area','')='' or f->>'area'=any(r.areas))
  and (first_date is null or coalesce(r.end_date,r.report_date)>=first_date) and (last_date is null or r.report_date<=last_date)
  and (coalesce(f->>'population','all')<>'open' or 'open'=any(r.flags))),
 filtered as materialized(select * from base r where (coalesce(f->>'status','')='' or r.status=f->>'status') and (coalesce(f->>'flag','')='' or f->>'flag'=any(r.flags))),
 page as(select * from filtered order by report_date desc nulls last,sort_at desc,id limit 25 offset skip)
 select jsonb_build_object('report',p_report,'role',actor_role,'generatedAt',statement_timestamp(),'total',(select count(*) from filtered),'offset',skip,'pageSize',25,
  'summary',jsonb_build_object('total',(select count(*) from base),'statuses',coalesce((select jsonb_object_agg(s,n) from (select status s,count(*) n from base group by status) x),'{}'::jsonb),'flags',coalesce((select jsonb_object_agg(s,n) from (select z s,count(*) n from base r cross join lateral unnest(r.flags) z group by z) x),'{}'::jsonb)),
  'options',jsonb_build_object('owners',coalesce((select jsonb_agg(jsonb_build_object('id',owner_id,'name',coalesce(owner_name,'Assigned team member')) order by owner_name,owner_id) from (select distinct owner_id,owner_name from authorized where owner_id is not null) x),'[]'::jsonb),'teams',coalesce((select jsonb_agg(team order by team) from (select distinct team from authorized) x),'[]'::jsonb),'areas',coalesce((select jsonb_agg(ar order by ar) from (select distinct unnest(areas) ar from authorized) x),'[]'::jsonb),'statuses',coalesce((select jsonb_agg(status order by status) from (select distinct status from authorized) x),'[]'::jsonb)),
  'rows',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'detail',detail,'cells',cells,'href',href) order by report_date desc nulls last,sort_at desc,id) from page),'[]'::jsonb)) into result;
 return result;
end $$;
revoke all on function private.report_sales_workflow(jsonb),private.operations_report_rows(uuid,text),public.get_operations_report(uuid,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.get_operations_report(uuid,text,jsonb) to service_role;
commit;
