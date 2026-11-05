-- ============================================================================
-- Front Office & Operations build-out, part 5: the rest of the front desk
--
--   1. Traces: a guest request of kind 'trace' is an internal follow-up for a
--      department on a date ("extra bed in 204 on the 12th"), shown on that
--      date's front desk and on the department's board.
--   2. Airport and station transfers: pick-up and drop on the booking, and a
--      list for the day.
--   3. Deposits: a due date, so the desk can chase deposits before arrival.
--   4. Complimentary and house-use stays: zero-rated room nights, approved by
--      someone holding bookings.complimentary, and kept out of ADR.
--   5. Room moves carry a reason code (upgrade, guest request, maintenance…)
--      as well as the free-text note.
--
-- Run after 0030_room_guests.sql.
-- ============================================================================

-- ── 1. Traces ───────────────────────────────────────────────────────────────

alter table guest_requests drop constraint if exists guest_requests_kind_check;
alter table guest_requests add constraint guest_requests_kind_check
  check (kind in ('wake_up_call', 'housekeeping', 'maintenance', 'message', 'request', 'complaint', 'trace'));
alter table guest_requests add column if not exists department_id uuid references departments on delete set null;
create index if not exists guest_requests_department_idx on guest_requests (department_id, status) where department_id is not null;

-- A trace is shown on its department's board, to people who do not work the
-- front desk (a room attendant, an engineer), and they mark it done there.
drop policy if exists guest_requests_trace_select on guest_requests;
drop policy if exists guest_requests_trace_update on guest_requests;
create policy guest_requests_trace_select on guest_requests for select
  using (kind = 'trace' and is_staff());
create policy guest_requests_trace_update on guest_requests for update
  using (kind = 'trace' and is_staff()) with check (kind = 'trace' and is_staff());

-- ── 2. Transfers ────────────────────────────────────────────────────────────

alter table bookings add column if not exists pickup_required boolean not null default false;
alter table bookings add column if not exists pickup_at       timestamptz;
alter table bookings add column if not exists pickup_details  text not null default '';
alter table bookings add column if not exists drop_required   boolean not null default false;
alter table bookings add column if not exists drop_at         timestamptz;
alter table bookings add column if not exists drop_details    text not null default '';

create index if not exists bookings_pickup_idx on bookings (property_id, pickup_at) where pickup_required;
create index if not exists bookings_drop_idx   on bookings (property_id, drop_at)   where drop_required;

-- ── 3. Deposit due date ─────────────────────────────────────────────────────

alter table bookings add column if not exists deposit_due_on date;
create index if not exists bookings_deposit_due_idx on bookings (property_id, deposit_due_on)
  where deposit_due_on is not null;

-- ── 4. Complimentary and house use ──────────────────────────────────────────

alter table bookings add column if not exists stay_type text not null default 'paid'
  check (stay_type in ('paid', 'complimentary', 'house_use'));
alter table bookings add column if not exists comp_reason      text not null default '';
alter table bookings add column if not exists comp_approved_by uuid references staff on delete set null;
alter table bookings add column if not exists comp_approved_at timestamptz;

/*
 * A stay is made complimentary (or house use) only by someone who may
 * approve it, and only with a reason; the approver is recorded. Turning it
 * back to paid clears the approval.
 */
create or replace function bookings_comp_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.stay_type = 'paid' then
    new.comp_reason := '';
    new.comp_approved_by := null;
    new.comp_approved_at := null;
    return new;
  end if;
  if tg_op = 'UPDATE' and new.stay_type = old.stay_type and new.comp_reason = old.comp_reason then
    return new;
  end if;
  if auth.uid() is not null and not has_permission('bookings.complimentary') then
    raise exception 'COMP_NOT_PERMITTED: only a manager can make a stay complimentary or house use';
  end if;
  if coalesce(btrim(new.comp_reason), '') = '' then
    raise exception 'COMP_REASON: give a reason for the complimentary or house-use stay';
  end if;
  new.comp_approved_by := auth.uid();
  new.comp_approved_at := now();
  return new;
end;
$$;

drop trigger if exists bookings_comp on bookings;
create trigger bookings_comp before insert or update of stay_type, comp_reason on bookings
  for each row execute function bookings_comp_guard();

insert into role_permissions (role_key, permission)
select r, p from (values
  ('manager', 'bookings.complimentary'), ('front_office_manager', 'bookings.complimentary')
) as seed (r, p)
where exists (select 1 from roles where key = seed.r)
on conflict do nothing;

-- ── 5. Room move reasons ────────────────────────────────────────────────────

alter table room_moves add column if not exists reason_code text not null default 'other'
  check (reason_code in ('upgrade', 'downgrade', 'guest_request', 'maintenance', 'housekeeping', 'noise', 'overbooking', 'other'));

-- ── 4b. Complimentary nights are not rooms sold ─────────────────────────────
--
-- USALI: complimentary and house-use rooms are not sold, so they stay out of
-- rooms sold (and so out of occupancy, ADR and RevPAR). report_daily is
-- re-issued from 0024 with that one condition added; night audit applies the
-- same rule to the closed-day figures it stores.

create or replace function report_daily(p_from date, p_to date)
returns table (
  day             date,
  source          text,
  rooms_available int,
  rooms_sold      int,
  room_revenue    numeric,
  other_revenue   numeric,
  tax_total       numeric,
  total_revenue   numeric
) language plpgsql stable security definer set search_path = public as $$
declare v_property uuid := current_property();
begin
  if not (has_permission('reports.financial') or has_permission('reports.view') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  return query
  with days as (
    select d::date as day from generate_series(p_from, p_to, interval '1 day') d
  ),
  audited as (
    select na.business_date, na.report
      from night_audits na
     where na.status = 'completed'
       and na.business_date between p_from and p_to
       and na.property_id = v_property
       and na.report ? 'rooms'
  )
  select
    days.day,
    case when a.report is not null then 'audit' else 'live' end as source,
    coalesce((a.report -> 'rooms' ->> 'available')::int, sellable_rooms()) as rooms_available,
    coalesce(
      (a.report -> 'rooms' ->> 'sold')::int,
      (select coalesce(sum(b.rooms_count), 0)::int
         from bookings b
        where b.check_in <= days.day and b.check_out > days.day
          and b.property_id = v_property
          and b.status in ('checked_in', 'checked_out')
          and b.stay_type = 'paid')
    ) as rooms_sold,
    coalesce(
      (a.report -> 'revenue' ->> 'room')::numeric,
      (select coalesce(sum(f.amount), 0)
         from folio_entries f
        where f.voided_at is null and f.kind = 'room' and f.stay_date = days.day
          and f.property_id = v_property)
    ) as room_revenue,
    coalesce(
      (a.report -> 'revenue' ->> 'fees')::numeric
        + (a.report -> 'revenue' ->> 'extras')::numeric
        + (a.report -> 'revenue' ->> 'penalties')::numeric,
      (select coalesce(sum(f.amount), 0)
         from folio_entries f
        where f.voided_at is null and f.kind in ('fee', 'extra', 'penalty')
          and f.property_id = v_property
          and local_day(f.created_at) = days.day)
    ) as other_revenue,
    coalesce(
      (a.report -> 'revenue' ->> 'tax')::numeric,
      (select coalesce(sum(f.tax_amount), 0)
         from folio_entries f
        where f.voided_at is null
          and f.kind in ('room', 'fee', 'extra', 'penalty')
          and f.property_id = v_property
          and coalesce(f.stay_date, local_day(f.created_at)) = days.day)
    ) as tax_total,
    coalesce(
      (a.report -> 'revenue' ->> 'total')::numeric,
      (select coalesce(sum(f.amount + f.tax_amount), 0)
         from folio_entries f
        where f.voided_at is null
          and f.kind in ('room', 'fee', 'extra', 'penalty')
          and f.property_id = v_property
          and coalesce(f.stay_date, local_day(f.created_at)) = days.day)
    ) as total_revenue
  from days
  left join audited a on a.business_date = days.day
  order by days.day;
end;
$$;
