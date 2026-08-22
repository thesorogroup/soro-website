-- Keep applicant birth dates within defensible calendar bounds at the database
-- boundary. This is data hygiene only; it does not impose a minimum working age.

create or replace function private.enforce_applicant_birth_date_bounds()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  if new.birth_date is not null and new.birth_date < date '1900-01-01' then
    raise exception using
      errcode = '22023',
      message = 'Date of birth cannot be earlier than 1900-01-01.';
  end if;

  if new.birth_date is not null and new.birth_date > current_date then
    raise exception using
      errcode = '22023',
      message = 'Date of birth cannot be in the future.';
  end if;

  return new;
end;
$$;

drop trigger if exists applicants_birth_date_bounds on public.applicants;
create trigger applicants_birth_date_bounds
before insert or update of birth_date on public.applicants
for each row execute function private.enforce_applicant_birth_date_bounds();

comment on function private.enforce_applicant_birth_date_bounds() is
  'Rejects malformed applicant birth-date ranges without storing a separate age value.';
