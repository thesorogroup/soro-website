-- JSON field names are identifiers, not locale-sorted display labels.
-- Production en_US.UTF-8 orders interviewerName before interviewId, unlike C.
-- Preserve the existing exact-key checks and all mutation authorization/history rules.
begin;

do $patch$
declare definition text; anchor constant text := 'array_agg(k order by k)'; matches integer;
begin
  definition := pg_get_functiondef('public.mutate_talent_verification(uuid,uuid,uuid,text,timestamptz,jsonb)'::regprocedure);
  matches := (length(definition)-length(replace(definition,anchor,'')))/length(anchor);
  if matches <> 2 then
    raise exception 'Previous interview validation patch expected two key-order checks; found %', matches;
  end if;
  execute replace(definition,anchor,'array_agg(k order by k collate "C")');
end $patch$;

commit;
