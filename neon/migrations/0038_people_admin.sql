-- ============================================================================
-- People & Admin: my profile, timesheets and overtime, system status
--
--   • staff.date_of_birth and staff.blood_group. set_my_profile() lets anyone
--     keep their own contact details up to date without HR access;
--     set_staff_hr() is restated with the new fields.
--   • Timesheets: one per person per week (Monday to Sunday). The hours are
--     worked out from attendance against the roster (app/lib/hr.ts
--     weekTimesheet) and frozen when approved. An approved week locks that
--     person's attendance for those seven days until HR reopens it, so payroll
--     is paid on figures that cannot move afterwards.
--   • Overtime limits per property: hours a day, hours a week, the smallest
--     block worth counting, and the rate printed in the payroll export. The
--     defaults (9 a day, 48 a week, double time) are the usual Factories Act /
--     Shops & Establishments limits; check the hotel's own state rules.
--   • job_runs, written by the scheduled jobs, and system_status() for the
--     System status page: migrations applied, database version and time, each
--     hotel's business date and last night audit, and each job's last run.
--   • report_attendance rewritten: the old one joined attendance and shifts
--     by person only, so present days and hours were multiplied by the number
--     of shifts, rostered days off counted as absences, and leave counted
--     requests rather than days.
--
-- Permissions:
--   hr.approve_time  approve and reject timesheets (seeded to everyone who
--                    approves leave)
--   data.export      download a property's data (no system role gets it; the
--                    superuser holds every key)
--
-- Run after 0037_flash_report.sql.
-- ============================================================================

-- ── 1. My profile ───────────────────────────────────────────────────────────

alter table staff add column if not exists date_of_birth date
  check (date_of_birth is null or date_of_birth between date '1900-01-01' and current_date);
alter table staff add column if not exists blood_group text not null default ''
  check (blood_group in ('', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'));

-- Your own contact details. Job, department, shift and pay stay with HR.
create or replace function set_my_profile(
  p_phone text, p_address text, p_emergency text, p_dob date, p_blood_group text
) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not permitted'; end if;
  update staff
     set phone = coalesce(btrim(p_phone), ''),
         address = coalesce(btrim(p_address), ''),
         emergency_contact = coalesce(btrim(p_emergency), ''),
         date_of_birth = p_dob,
         blood_group = coalesce(p_blood_group, '')
   where id = auth.uid();
end;
$$;

drop function if exists set_staff_hr(uuid, text, uuid, text, date, uuid, smallint, text, text, text);
create or replace function set_staff_hr(
  p_staff uuid, p_code text, p_department uuid, p_designation text, p_joining date,
  p_shift uuid, p_weekly_off smallint, p_phone text, p_address text, p_emergency text,
  p_dob date default null, p_blood_group text default ''
)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not has_permission('hr.manage') then raise exception 'not permitted'; end if;
  update staff
     set employee_code = nullif(trim(p_code), ''),
         department_id = p_department,
         job_title = coalesce(trim(p_designation), ''),
         joining_date = p_joining,
         default_shift_id = p_shift,
         weekly_off = p_weekly_off,
         phone = coalesce(trim(p_phone), ''),
         address = coalesce(trim(p_address), ''),
         emergency_contact = coalesce(trim(p_emergency), ''),
         date_of_birth = p_dob,
         blood_group = coalesce(p_blood_group, '')
   where id = p_staff
     and can_access_property(property_id);
end;
$$;

-- ── 2. Overtime limits ──────────────────────────────────────────────────────

alter table properties add column if not exists hr_ot_daily_hours numeric(4,2) not null default 9
  check (hr_ot_daily_hours between 1 and 24);
alter table properties add column if not exists hr_ot_weekly_hours numeric(5,2) not null default 48
  check (hr_ot_weekly_hours between 1 and 168);
alter table properties add column if not exists hr_ot_min_minutes int not null default 30
  check (hr_ot_min_minutes between 0 and 240);
alter table properties add column if not exists hr_ot_rate numeric(4,2) not null default 2
  check (hr_ot_rate between 1 and 5);

create or replace view property_settings with (security_invoker = true) as
  select * from properties where id = current_property();

create or replace function set_hr_overtime(p_daily numeric, p_weekly numeric, p_min int, p_rate numeric)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not has_permission('hr.manage') then raise exception 'not permitted'; end if;
  update properties
     set hr_ot_daily_hours = p_daily, hr_ot_weekly_hours = p_weekly,
         hr_ot_min_minutes = p_min, hr_ot_rate = p_rate
   where id = current_property();
end;
$$;

-- ── 3. Timesheets ───────────────────────────────────────────────────────────

create table if not exists timesheets (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null default current_property() references properties on delete restrict,
  staff_id       uuid not null references staff on delete cascade,
  week_start     date not null check (extract(isodow from week_start) = 1),
  status         text not null check (status in ('submitted', 'approved', 'rejected')),
  regular_hours  numeric(6,2) not null default 0 check (regular_hours >= 0),
  overtime_hours numeric(6,2) not null default 0 check (overtime_hours >= 0),
  off_day_hours  numeric(6,2) not null default 0 check (off_day_hours >= 0),
  -- One entry per day, as the figures stood when submitted or approved:
  -- { date, shift, scheduled, worked, regular, overtime, off_day, leave, late }
  days           jsonb not null default '[]',
  note           text not null default '',
  submitted_at   timestamptz,
  decided_by     uuid references staff on delete set null,
  decided_at     timestamptz,
  decision_note  text not null default '',
  updated_at     timestamptz not null default now(),
  unique (staff_id, week_start)
);

create index if not exists timesheets_week_idx on timesheets (property_id, week_start);

alter table timesheets enable row level security;
drop policy if exists timesheets_select   on timesheets;
drop policy if exists timesheets_property on timesheets;
create policy timesheets_select on timesheets for select
  using (staff_id = auth.uid() or has_permission('hr.view') or has_permission('hr.approve_time')
         or has_permission('hr.export'));
create policy timesheets_property on timesheets as restrictive for all
  using (can_access_property(property_id)) with check (can_access_property(property_id));

drop trigger if exists timesheets_audit on timesheets;
create trigger timesheets_audit after insert or update or delete on timesheets
  for each row execute function audit_row('hr');

-- The figures a timesheet carries, checked for shape.
create or replace function timesheet_check_days(p_days jsonb)
returns void language plpgsql immutable as $$
begin
  if p_days is null or jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) <> 7 then
    raise exception 'TIMESHEET_BAD_DAYS: a timesheet covers seven days';
  end if;
end;
$$;

/*
 * Submits your own timesheet for a week that has ended. It can be submitted
 * again (with corrected figures) until it is approved.
 */
create or replace function timesheet_submit(
  p_week date, p_note text, p_regular numeric, p_overtime numeric, p_off_day numeric, p_days jsonb
) returns timesheets
language plpgsql volatile security definer set search_path = public as $$
declare
  v_row timesheets;
begin
  if auth.uid() is null then raise exception 'not permitted'; end if;
  if extract(isodow from p_week) <> 1 then
    raise exception 'TIMESHEET_BAD_WEEK: a timesheet week starts on a Monday';
  end if;
  if p_week + 6 >= local_day(now()) then
    raise exception 'TIMESHEET_WEEK_OPEN: submit the week once it is over';
  end if;
  perform timesheet_check_days(p_days);

  select * into v_row from timesheets where staff_id = auth.uid() and week_start = p_week;
  if v_row.status = 'approved' then
    raise exception 'TIMESHEET_APPROVED: that week is already approved';
  end if;

  insert into timesheets (staff_id, week_start, status, regular_hours, overtime_hours, off_day_hours,
                          days, note, submitted_at)
  values (auth.uid(), p_week, 'submitted', round(p_regular, 2), round(p_overtime, 2), round(p_off_day, 2),
          p_days, coalesce(btrim(p_note), ''), now())
  on conflict (staff_id, week_start) do update
     set status = 'submitted', regular_hours = excluded.regular_hours,
         overtime_hours = excluded.overtime_hours, off_day_hours = excluded.off_day_hours,
         days = excluded.days, note = excluded.note, submitted_at = now(),
         decided_by = null, decided_at = null, decision_note = '', updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

/*
 * Approves or rejects someone's week. The figures are recomputed by the app
 * from attendance at the moment of approval and passed in, so what is
 * approved is what attendance says, whatever was submitted. Approving a week
 * nobody submitted is allowed. Never your own.
 */
create or replace function timesheet_decide(
  p_staff uuid, p_week date, p_approve boolean, p_note text,
  p_regular numeric, p_overtime numeric, p_off_day numeric, p_days jsonb
) returns timesheets
language plpgsql volatile security definer set search_path = public as $$
declare
  v_row     timesheets;
  v_prop    uuid;
begin
  if not has_permission('hr.approve_time') then raise exception 'not permitted'; end if;
  if p_staff = auth.uid() then
    raise exception 'TIMESHEET_OWN: someone else has to approve your timesheet';
  end if;
  select property_id into v_prop from staff where id = p_staff;
  if v_prop is null or not can_access_property(v_prop) then
    raise exception 'TIMESHEET_NO_STAFF: staff member not found';
  end if;
  if extract(isodow from p_week) <> 1 then
    raise exception 'TIMESHEET_BAD_WEEK: a timesheet week starts on a Monday';
  end if;
  if p_week + 6 >= local_day(now()) then
    raise exception 'TIMESHEET_WEEK_OPEN: decide the week once it is over';
  end if;
  if not p_approve and coalesce(btrim(p_note), '') = '' then
    raise exception 'TIMESHEET_REASON: give a reason for rejecting';
  end if;
  perform timesheet_check_days(p_days);

  select * into v_row from timesheets where staff_id = p_staff and week_start = p_week;
  if v_row.status = 'approved' then
    raise exception 'TIMESHEET_APPROVED: that week is already approved; reopen it first';
  end if;

  insert into timesheets (property_id, staff_id, week_start, status, regular_hours, overtime_hours,
                          off_day_hours, days, decided_by, decided_at, decision_note)
  values (current_property(), p_staff, p_week, case when p_approve then 'approved' else 'rejected' end,
          round(p_regular, 2), round(p_overtime, 2), round(p_off_day, 2), p_days,
          auth.uid(), now(), coalesce(btrim(p_note), ''))
  on conflict (staff_id, week_start) do update
     set status = excluded.status, regular_hours = excluded.regular_hours,
         overtime_hours = excluded.overtime_hours, off_day_hours = excluded.off_day_hours,
         days = excluded.days, decided_by = auth.uid(), decided_at = now(),
         decision_note = excluded.decision_note, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

-- Unlocks an approved week so attendance can be corrected; it goes back to
-- "submitted" and has to be approved again.
create or replace function timesheet_reopen(p_id uuid)
returns timesheets
language plpgsql volatile security definer set search_path = public as $$
declare
  v_row timesheets;
begin
  if not has_permission('hr.manage') then raise exception 'not permitted'; end if;
  update timesheets
     set status = 'submitted', decided_by = null, decided_at = null,
         decision_note = 'Reopened by ' || coalesce((select full_name from staff where id = auth.uid()), 'HR'),
         updated_at = now()
   where id = p_id and status = 'approved' and can_access_property(property_id)
  returning * into v_row;
  if v_row.id is null then raise exception 'TIMESHEET_NOT_APPROVED: only an approved week can be reopened'; end if;
  return v_row;
end;
$$;

revoke execute on function set_my_profile(text, text, text, date, text) from public, anon;
revoke execute on function timesheet_submit(date, text, numeric, numeric, numeric, jsonb) from public, anon;
revoke execute on function timesheet_decide(uuid, date, boolean, text, numeric, numeric, numeric, jsonb) from public, anon;
revoke execute on function timesheet_reopen(uuid) from public, anon;
revoke execute on function set_hr_overtime(numeric, numeric, int, numeric) from public, anon;
grant execute on function set_my_profile(text, text, text, date, text) to authenticated, service_role;
grant execute on function timesheet_submit(date, text, numeric, numeric, numeric, jsonb) to authenticated, service_role;
grant execute on function timesheet_decide(uuid, date, boolean, text, numeric, numeric, numeric, jsonb) to authenticated, service_role;
grant execute on function timesheet_reopen(uuid) to authenticated, service_role;
grant execute on function set_hr_overtime(numeric, numeric, int, numeric) to authenticated, service_role;

-- An approved week locks that person's attendance for its seven days.
create or replace function attendance_week_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and exists (
       select 1 from timesheets t
        where t.staff_id = old.staff_id and t.status = 'approved'
          and old.work_date between t.week_start and t.week_start + 6) then
    raise exception 'TIMESHEET_LOCKED: the week of % is approved; reopen the timesheet to change it', old.work_date;
  end if;
  if tg_op in ('INSERT', 'UPDATE') and exists (
       select 1 from timesheets t
        where t.staff_id = new.staff_id and t.status = 'approved'
          and new.work_date between t.week_start and t.week_start + 6) then
    raise exception 'TIMESHEET_LOCKED: the week of % is approved; reopen the timesheet to change it', new.work_date;
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists attendance_week_lock on attendance;
create trigger attendance_week_lock before insert or update or delete on attendance
  for each row execute function attendance_week_lock();

-- ── 4. Permissions ──────────────────────────────────────────────────────────

insert into role_permissions (role_key, permission)
select distinct role_key, 'hr.approve_time'
  from role_permissions
 where permission = 'hr.approve_leave'
on conflict do nothing;

-- ── 5. Scheduled jobs and system status ─────────────────────────────────────

create table if not exists job_runs (
  id           bigint generated always as identity primary key,
  job          text not null,
  property_id  uuid references properties on delete cascade,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  detail       text not null default ''
);

create index if not exists job_runs_job_idx on job_runs (job, started_at desc);

-- Written by the scheduler with the service key; read through system_status().
alter table job_runs enable row level security;
drop policy if exists job_runs_select on job_runs;
create policy job_runs_select on job_runs for select using (has_permission('settings.manage'));

create or replace function system_status()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_migrations jsonb;
  v_hotels     jsonb;
  v_jobs       jsonb;
begin
  if not has_permission('settings.manage') then raise exception 'not permitted'; end if;

  -- The migration runner's ledger (scripts/db-migrate.mjs); absent on a
  -- database set up another way.
  if to_regclass('bluinn_meta.migrations') is not null then
    execute 'select jsonb_build_object(''count'', count(*), ''latest'', max(name), ''latest_at'', max(applied_at))
               from bluinn_meta.migrations'
       into v_migrations;
  else
    v_migrations := jsonb_build_object('count', 0, 'latest', null, 'latest_at', null);
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', p.id,
           'code', p.code,
           'name', p.name,
           'is_active', p.is_active,
           'business_date', p.business_date,
           'timezone', p.timezone,
           'today', (now() at time zone p.timezone)::date,
           'last_audit', (select jsonb_build_object('date', na.business_date, 'status', na.status,
                                                     'at', coalesce(na.completed_at, na.started_at))
                            from night_audits na
                           where na.property_id = p.id
                           order by na.business_date desc limit 1)
         ) order by p.sort_order, p.name), '[]'::jsonb)
    into v_hotels
    from properties p
   where can_access_property(p.id);

  select coalesce(jsonb_agg(j order by j ->> 'job'), '[]'::jsonb) into v_jobs
    from (
      select distinct on (r.job) jsonb_build_object(
               'job', r.job, 'started_at', r.started_at, 'finished_at', r.finished_at,
               'ok', r.ok, 'detail', r.detail) as j
        from job_runs r
       order by r.job, r.started_at desc
    ) x;

  return jsonb_build_object(
    'migrations', v_migrations,
    'database', jsonb_build_object('version', current_setting('server_version'), 'now', now()),
    'hotels', v_hotels,
    'jobs', v_jobs
  );
end;
$$;

revoke execute on function system_status() from public, anon;
grant execute on function system_status() to authenticated, service_role;

-- ── 6. Staff attendance report, counted properly ────────────────────────────

create or replace function report_attendance(p_from date, p_to date)
returns table (
  staff_name text, department text, present int, absent int, leave_days int, hours numeric
) language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid := current_property();
  v_today    date := local_day(now());
begin
  if not (has_permission('reports.view') or has_permission('hr.view') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  return query
  with people as (
    select s.id, s.full_name, coalesce(d.name, '') as dept
      from staff s
      left join departments d on d.id = s.department_id
     where (s.is_active
            or exists (select 1 from attendance a where a.staff_id = s.id
                         and a.work_date between p_from and p_to and a.property_id = v_property))
       and (s.property_id = v_property
            or exists (select 1 from staff_properties sp
                        where sp.staff_id = s.id and sp.property_id = v_property))
  ),
  leave_days as (
    select lr.staff_id, d::date as day
      from leave_requests lr
      cross join lateral generate_series(greatest(lr.start_date, p_from), least(lr.end_date, p_to), interval '1 day') d
     where lr.status = 'approved' and lr.property_id = v_property
       and lr.start_date <= p_to and lr.end_date >= p_from
  )
  select p.full_name,
         p.dept,
         (select count(distinct a.work_date)::int from attendance a
           where a.staff_id = p.id and a.property_id = v_property
             and a.work_date between p_from and p_to),
         (select count(*)::int from staff_shifts sh
           where sh.staff_id = p.id and sh.property_id = v_property
             and sh.shift_type_id is not null
             and sh.shift_date between p_from and least(p_to, v_today)
             and not exists (select 1 from attendance a
                              where a.staff_id = p.id and a.work_date = sh.shift_date)
             and not exists (select 1 from leave_days l
                              where l.staff_id = p.id and l.day = sh.shift_date)),
         (select count(distinct l.day)::int from leave_days l where l.staff_id = p.id),
         (select round(coalesce(sum(extract(epoch from (a.clock_out - a.clock_in)) / 3600), 0), 1)
            from attendance a
           where a.staff_id = p.id and a.property_id = v_property
             and a.work_date between p_from and p_to and a.clock_out is not null)
    from people p
   order by p.full_name;
end;
$$;
