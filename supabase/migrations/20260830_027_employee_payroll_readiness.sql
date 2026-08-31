-- Soro Operations: Administrator-only Employee Payroll readiness summary.
--
-- Readiness is derived entirely on the server from the signed-in
-- Administrator's organization. The summary contains counts only: no employee
-- names, contact details, payment addresses, or cross-organization data.
-- Its default as-of date matches the UI's upcoming-Friday payroll period end.
-- Final draft eligibility is still enforced against the Administrator-selected
-- period end by create_employee_payroll_run.

create or replace function private.employee_payroll_readiness_json(
  p_organization_id uuid,
  p_as_of date default null
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  with business_clock as (
    select (pg_catalog.statement_timestamp() at time zone 'America/Chicago')::date
      as business_date
  ), boundary as (
    select coalesce(
      p_as_of,
      business_clock.business_date
        + (((5 - extract(isodow from business_clock.business_date)::integer + 7) % 7) - 1)
    )::date as as_of
    from business_clock
  ), counts as (
    select
      count(access.id)::integer as total,
      count(*) filter (
        where access.active = true
          and profile.hire_date <= boundary.as_of
          and profile.payment_route = 'wise_contractor'::public.employee_payment_route
      )::integer as wise_eligible,
      count(*) filter (
        where access.active = true
          and profile.hire_date <= boundary.as_of
          and profile.payment_route = 'wise_contractor'::public.employee_payment_route
          and nullif(btrim(profile.payout_recipient_email), '') is not null
      )::integer as wise_configured,
      count(*) filter (
        where access.active = true
          and profile.hire_date <= boundary.as_of
          and profile.payment_route = 'needs_setup'::public.employee_payment_route
      )::integer as needs_setup,
      count(*) filter (
        where access.active = true
          and profile.hire_date <= boundary.as_of
          and profile.payment_route = 'quickbooks_employee'::public.employee_payment_route
      )::integer as quickbooks,
      count(*) filter (where access.active = false)::integer as inactive,
      count(*) filter (
        where access.active = true
          and profile.hire_date > boundary.as_of
      )::integer as future_hire
    from boundary
    left join public.employee_profiles as profile
      on profile.organization_id = p_organization_id
    left join public.platform_users as access
      on access.id = profile.user_id
     and access.organization_id = profile.organization_id
  )
  select jsonb_build_object(
    'asOf', boundary.as_of,
    'total', coalesce(counts.total, 0),
    'wiseEligible', coalesce(counts.wise_eligible, 0),
    'wiseConfigured', coalesce(counts.wise_configured, 0),
    'needsSetup', coalesce(counts.needs_setup, 0),
    'quickbooks', coalesce(counts.quickbooks, 0),
    'inactive', coalesce(counts.inactive, 0),
    'futureHire', coalesce(counts.future_hire, 0),
    'canRunPayroll', coalesce(counts.wise_eligible, 0) > 0
  )
  from boundary
  cross join counts;
$$;

revoke all on function private.employee_payroll_readiness_json(uuid, date)
  from public, anon, authenticated;
grant execute on function private.employee_payroll_readiness_json(uuid, date)
  to service_role;

create or replace function public.get_admin_payroll_workspace(p_actor_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_actor record;
begin
  select * into v_actor from private.financial_actor(p_actor_user_id, true);

  return jsonb_build_object(
    'generatedAt', pg_catalog.clock_timestamp(),
    'viewerRole', v_actor.role::text,
    'employeePayroll', case
      when v_actor.role = 'admin'::public.platform_role then
        jsonb_build_object(
          'readiness', private.employee_payroll_readiness_json(v_actor.organization_id, null),
          'runs', private.employee_payroll_runs_json(v_actor.organization_id)
        )
      else null
    end,
    'talentPayouts', jsonb_build_object(
      'runs', private.talent_payout_runs_json(v_actor.organization_id, v_actor.role)
    )
  );
end;
$$;

revoke all on function public.get_admin_payroll_workspace(uuid)
  from public, anon, authenticated;
grant execute on function public.get_admin_payroll_workspace(uuid)
  to service_role;

comment on function private.employee_payroll_readiness_json(uuid, date) is
  'Service-only organization-scoped employee payment-route readiness counts without employee PII.';
comment on function public.get_admin_payroll_workspace(uuid) is
  'Service-only role-scoped Employee Payroll and Talent Payout workspace with Administrator-only employee readiness counts.';
