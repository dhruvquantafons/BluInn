-- ============================================================================
-- Sections 1, 3 and 4 of docs/interconnection-audit-2026-11-12.md: the
-- database half of the missing validations and dead buttons (the app half is
-- in the actions and pages). Run after 0042_event_rooms_and_till_stock.sql.
-- ============================================================================

-- ── POS: the room-charge limit counts only what the stay still owes ────────

create or replace function pos_charge_to_room(p_order uuid, p_booking uuid, p_folio uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_order    record;
  v_outlet   record;
  v_booking  record;
  v_folio    uuid := p_folio;
  v_company  uuid;
  v_owing    numeric(12,2);
  v_limit    numeric(12,2);
  v_posted   numeric(12,2);
  v_band     record;
  v_payment  uuid;
  v_label    text;
  v_staff    uuid := auth.uid();
begin
  if not pos_may_pay((select outlet_id from pos_orders where id = p_order)) then
    raise exception 'not permitted';
  end if;

  -- 0043: one till at a time.
  select * into v_order from pos_orders where id = p_order for update;
  if v_order is null then
    raise exception 'POS_NO_ORDER' using hint = 'That bill no longer exists.';
  end if;
  if v_order.status = 'void' then
    raise exception 'POS_ORDER_VOID' using hint = 'That bill has been voided.';
  end if;

  v_owing := pos_order_balance(p_order);
  if v_owing <= 0 then
    raise exception 'POS_NOTHING_OWED' using hint = 'This bill is already settled.';
  end if;

  select * into v_outlet from pos_outlets where id = v_order.outlet_id;

  select b.*, g.full_name as guest_full_name
    into v_booking
    from bookings b left join guests g on g.id = b.guest_id
   where b.id = p_booking;
  if v_booking is null then
    raise exception 'POS_NO_BOOKING' using hint = 'Choose the room the guest is staying in.';
  end if;
  -- 0041: a bill from one hotel is never charged to a stay at another.
  if v_booking.property_id is distinct from v_order.property_id then
    raise exception 'POS_OTHER_PROPERTY: that guest is staying at another hotel; take payment at the outlet instead';
  end if;
  if v_booking.status <> 'checked_in' then
    raise exception 'POS_NOT_CHECKED_IN'
      using hint = 'Only a guest who is checked in may charge to their room. Take payment at the outlet instead.';
  end if;

  if v_folio is null then
    v_folio := master_folio(p_booking);
  end if;
  if not exists (select 1 from folios where id = v_folio and booking_id = p_booking) then
    raise exception 'FOLIO_BOOKING_MISMATCH' using hint = 'That folio belongs to a different booking.';
  end if;
  -- 0040: a stay already invoiced takes new charges on its "After invoice"
  -- folio (0039). Choose it here, before anything is posted, so the charges,
  -- the "already paid" credit and the payment record all land together.
  if folio_is_invoiced(v_folio) then
    v_folio := after_invoice_folio(p_booking);
  end if;

  -- The property's cap on how much outlet spend one stay may carry unpaid.
  -- 0043: unpaid means still owed. It used to count every bill ever charged,
  -- so a guest who had settled their folio could still hit the limit.
  select pos_room_charge_limit into v_limit from property_settings limit 1;
  if coalesce(v_limit, 0) > 0 then
    select least(
             coalesce((select sum(p.amount) from pos_payments p
                        where p.kind = 'room_charge' and p.voided_at is null and p.booking_id = p_booking), 0),
             greatest(stay_balance(p_booking), 0))
      into v_posted;
    if v_posted + v_owing > v_limit then
      raise exception 'POS_ROOM_CHARGE_LIMIT: this stay carries % of a % outlet limit; this bill adds %',
        v_posted, v_limit, v_owing;
    end if;
  end if;

  -- A folio billed to a company is the company's debt, so its limit applies.
  select company_id into v_company from folios where id = v_folio;
  if v_company is not null then
    if exists (
      select 1 from companies
       where id = v_company and credit_limit is not null
         and company_balance(v_company) + v_owing > credit_limit
    ) then
      raise exception 'CITY_LEDGER_CREDIT_LIMIT: this bill of % would take the company past its credit limit',
        v_owing;
    end if;
  end if;

  v_label := v_outlet.name || ' — ' || v_order.number;

  -- The goods and services, grouped by tax rate.
  for v_band in
    select tax_rate, sum(net_amount) as net, sum(tax_amount) as tax
      from pos_order_lines
     where order_id = p_order and voided_at is null
     group by tax_rate
     having sum(net_amount) + sum(tax_amount) > 0
     order by tax_rate
  loop
    insert into folio_entries (booking_id, folio_id, kind, description, amount, tax_amount, tax_rate, reference, created_by)
    values (p_booking, v_folio, 'extra', v_label, v_band.net, v_band.tax, v_band.tax_rate, v_order.number, v_staff);
  end loop;

  if v_order.service_net > 0 then
    insert into folio_entries (booking_id, folio_id, kind, description, amount, tax_amount, tax_rate, reference, created_by)
    values (p_booking, v_folio, 'extra', v_label || ' — service charge',
            v_order.service_net, v_order.service_tax, v_outlet.tax_rate, v_order.number, v_staff);
  end if;

  if v_order.tip_amount > 0 then
    insert into folio_entries (booking_id, folio_id, kind, description, amount, tax_amount, tax_rate, reference, created_by)
    values (p_booking, v_folio, 'extra', v_label || ' — tip', v_order.tip_amount, 0, 0, v_order.number, v_staff);
  end if;

  -- Part of the bill was already paid at the outlet: credit it back on the
  -- folio, as event_post_to_folio does, so the guest is not charged twice.
  -- (Before 0032 the full bill went to the folio and only the balance was
  -- recorded as the room charge.)
  if v_order.grand_total - v_owing > 0 then
    insert into folio_entries (booking_id, folio_id, kind, description, amount, tax_amount, tax_rate, reference, created_by)
    values (p_booking, v_folio, 'adjustment', v_label || ' — already paid at the outlet',
            round(v_order.grand_total - v_owing, 2), 0, 0, v_order.number, v_staff);
  end if;

  insert into pos_payments (order_id, kind, amount, booking_id, folio_id, reference, created_by)
  values (p_order, 'room_charge', v_owing, p_booking, v_folio,
          coalesce(v_booking.reference, ''), v_staff)
  returning id into v_payment;

  update pos_orders
     set booking_id = coalesce(booking_id, p_booking),
         guest_name = case when guest_name = '' then coalesce(v_booking.guest_full_name, v_booking.contact_name, '') else guest_name end,
         status = 'settled',
         closed_at = now()
   where id = p_order;

  return v_payment;
end;
$$;

-- ── POS: one till at a time on a bill ───────────────────────────────────────

create or replace function pos_take_payment(p_order uuid, p_kind text, p_amount numeric, p_reference text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_owing numeric(12,2);
  v_status text;
  v_id    uuid;
begin
  if not has_permission('pos.pay') then
    raise exception 'not permitted';
  end if;
  if p_kind not in ('cash', 'card', 'upi', 'other') then
    raise exception 'POS_PAYMENT_KIND'
      using hint = 'Use charge to room or a points redemption for those.';
  end if;
  if coalesce(p_amount, 0) <= 0 then
    raise exception 'POS_AMOUNT_INVALID' using hint = 'Enter the amount taken.';
  end if;

  -- 0043: locked, so two tills cannot both take the same balance.
  select status into v_status from pos_orders where id = p_order for update;
  if v_status is null then
    raise exception 'POS_NO_ORDER' using hint = 'That bill no longer exists.';
  end if;
  if v_status = 'void' then
    raise exception 'POS_ORDER_VOID' using hint = 'That bill has been voided.';
  end if;

  v_owing := pos_order_balance(p_order);
  if v_owing <= 0 then
    raise exception 'POS_NOTHING_OWED' using hint = 'This bill is already settled.';
  end if;
  if p_amount > v_owing then
    raise exception 'POS_OVERPAYMENT: % is owed but % was entered', v_owing, p_amount;
  end if;

  insert into pos_payments (order_id, kind, amount, reference, created_by)
  values (p_order, p_kind, p_amount, coalesce(p_reference, ''), auth.uid())
  returning id into v_id;

  if pos_order_balance(p_order) <= 0 then
    update pos_orders set status = 'settled', closed_at = now() where id = p_order;
  else
    update pos_orders set status = 'billed' where id = p_order and status = 'open';
  end if;

  return v_id;
end;
$$;

create or replace function pos_redeem_points(p_order uuid, p_guest uuid, p_points int)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_tier  record;
  v_min   int;
  v_value numeric(12,2);
  v_owing numeric(12,2);
  v_status text;
begin
  if not (has_permission('pos.pay') and has_permission('loyalty.redeem')) then
    raise exception 'not permitted';
  end if;

  -- 0043: locked, so two tills cannot both take the same balance.
  select status into v_status from pos_orders where id = p_order for update;
  if v_status is null then
    raise exception 'POS_NO_ORDER' using hint = 'That bill no longer exists.';
  end if;
  if v_status = 'void' then
    raise exception 'POS_ORDER_VOID' using hint = 'That bill has been voided.';
  end if;

  select loyalty_min_redeem_points into v_min from property_settings limit 1;
  if p_points < coalesce(v_min, 0) then
    raise exception 'LOYALTY_BELOW_MINIMUM: the smallest redemption is % points', coalesce(v_min, 0);
  end if;

  select t.* into v_tier
    from guests g join loyalty_tiers t on t.key = g.loyalty_tier
   where g.id = p_guest and g.loyalty_opt_in;
  if v_tier is null then
    raise exception 'LOYALTY_NOT_A_MEMBER' using hint = 'Enrol the guest in the loyalty programme first.';
  end if;
  if v_tier.redeem_rate <= 0 then
    raise exception 'LOYALTY_NO_REDEEM_RATE' using hint = 'This tier has no redemption rate set.';
  end if;

  v_value := round(p_points * v_tier.redeem_rate, 2);
  v_owing := pos_order_balance(p_order);
  if v_owing <= 0 then
    raise exception 'POS_NOTHING_OWED' using hint = 'This bill is already settled.';
  end if;
  if v_value > v_owing then
    raise exception 'LOYALTY_OVER_BALANCE: % is worth % but only % is owed', p_points, v_value, v_owing;
  end if;

  perform loyalty_consume(p_guest, p_points);

  insert into pos_payments (order_id, kind, amount, points, reference, created_by)
  values (p_order, 'loyalty_points', v_value, p_points,
          (select loyalty_member_no from guests where id = p_guest), auth.uid());

  insert into loyalty_transactions (guest_id, kind, points, base_amount, tier, description, created_by)
  values (p_guest, 'redeem', -p_points, v_value, v_tier.key,
          'Redeemed at ' || (select o.name from pos_orders po join pos_outlets o on o.id = po.outlet_id where po.id = p_order)
            || ' — ' || (select number from pos_orders where id = p_order),
          auth.uid());

  if pos_order_balance(p_order) <= 0 then
    update pos_orders set status = 'settled', closed_at = now() where id = p_order;
  else
    update pos_orders set status = 'billed' where id = p_order and status = 'open';
  end if;

  return v_value;
end;
$$;

-- ── HR: timesheets ──────────────────────────────────────────────────────────

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
  -- 0043: the hours claimed are checked against what attendance shows.
  perform timesheet_check_hours(auth.uid(), p_week, p_regular, p_overtime, p_off_day);

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
  perform timesheet_check_hours(p_staff, p_week, p_regular, p_overtime, p_off_day);

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

create or replace function timesheet_reopen(p_id uuid)
returns timesheets
language plpgsql volatile security definer set search_path = public as $$
declare
  v_row timesheets;
begin
  -- 0043: whoever may approve a week may reopen it (approvers could not).
  if not (has_permission('hr.manage') or has_permission('hr.approve_time')) then raise exception 'not permitted'; end if;
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

create or replace function clock_out(p_lat numeric default null, p_lng numeric default null)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_distance int;
  v_id uuid;
begin
  if not is_staff() then raise exception 'not permitted'; end if;
  -- 0043: leaving is never refused for being off site (someone who forgot to
  -- clock out before leaving stayed clocked in); the distance is still kept.
  v_distance := hr_distance_m(p_lat, p_lng);
  update attendance set clock_out = now(), out_distance_m = v_distance
   where staff_id = auth.uid() and clock_out is null
  returning id into v_id;
  if v_id is null then raise exception 'NOT_IN' using errcode = 'P0001'; end if;
  return v_id;
end;
$$;

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
  -- 0043: it used to report success having changed nothing.
  if not found then
    raise exception 'STAFF_NOT_FOUND: that staff member is not at the hotel you are working in';
  end if;
end;
$$;

/* What attendance shows for a person's week, in hours (a shift still open counts to now). */
create or replace function timesheet_worked_hours(p_staff uuid, p_week date)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce(sum(extract(epoch from (coalesce(clock_out, now()) - clock_in)) / 3600.0), 0), 2)
    from attendance
   where staff_id = p_staff and work_date between p_week and p_week + 6;
$$;

/* A timesheet may not claim more than attendance shows, give or take 15 minutes. */
create or replace function timesheet_check_hours(p_staff uuid, p_week date, p_regular numeric, p_overtime numeric, p_off_day numeric)
returns void language plpgsql stable security definer set search_path = public as $$
declare
  v_worked numeric := timesheet_worked_hours(p_staff, p_week);
  v_claim  numeric := coalesce(p_regular, 0) + coalesce(p_overtime, 0) + coalesce(p_off_day, 0);
begin
  if v_claim < 0 or coalesce(p_regular, 0) < 0 or coalesce(p_overtime, 0) < 0 or coalesce(p_off_day, 0) < 0 then
    raise exception 'TIMESHEET_HOURS: hours cannot be negative';
  end if;
  if v_claim > v_worked + 0.25 then
    raise exception 'TIMESHEET_HOURS: % hours claimed but attendance shows %', round(v_claim, 2), v_worked;
  end if;
end;
$$;

/*
 * As 0038, plus: closing a shift that is still open is allowed in an approved
 * week. A night-shift worker whose week was approved while they were still on
 * shift could neither clock out nor clock back in.
 */
create or replace function attendance_week_lock()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and old.clock_out is null and new.clock_out is not null
     and (to_jsonb(new) - array['clock_out', 'out_distance_m', 'updated_at'])
         = (to_jsonb(old) - array['clock_out', 'out_distance_m', 'updated_at']) then
    return new;
  end if;
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

-- ── HR: leave ───────────────────────────────────────────────────────────────

/* Leave cannot cover a day the person worked. */
create or replace function leave_not_on_worked_days()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_day date;
begin
  if new.status not in ('pending', 'approved') then return new; end if;
  if tg_op = 'UPDATE' and new.start_date = old.start_date and new.end_date = old.end_date
     and old.status in ('pending', 'approved') then
    return new;
  end if;
  select work_date into v_day from attendance
   where staff_id = new.staff_id and work_date between new.start_date and new.end_date
   order by work_date limit 1;
  if v_day is not null then
    raise exception 'LEAVE_WORKED: % was a working day (there is attendance for it)', to_char(v_day, 'DD Mon YYYY');
  end if;
  return new;
end;
$$;

drop trigger if exists leave_requests_not_worked on leave_requests;
create trigger leave_requests_not_worked
  before insert or update of start_date, end_date, status on leave_requests
  for each row execute function leave_not_on_worked_days();

/*
 * Approved leave can be withdrawn: by the person themselves until it starts,
 * and by HR (hr.manage) at any time. Approvers decide others' requests as before.
 */
drop policy if exists leave_update on leave_requests;
create policy leave_update on leave_requests for update
  using ((staff_id = auth.uid() and (status = 'pending' or (status = 'approved' and start_date > local_day(now()))))
         or (has_permission('hr.approve_leave') and staff_id <> auth.uid())
         or has_permission('hr.manage'))
  with check ((staff_id = auth.uid() and status in ('pending', 'cancelled'))
              or (has_permission('hr.approve_leave') and staff_id <> auth.uid())
              or has_permission('hr.manage'));

-- ── Folio ───────────────────────────────────────────────────────────────────

/*
 * What a stay owes: its guest folios' charges and refunds, less payments and
 * credits (organiser folios excluded). It runs with the caller's rights, so
 * the till can ask it and still see only its own hotel's folios; the triggers
 * and functions that use it are security definer and see every row.
 */
create or replace function stay_balance(p_booking uuid)
returns numeric language sql stable security invoker set search_path = public as $$
  select round(coalesce(sum(case when e.kind in ('room', 'fee', 'penalty', 'extra', 'refund') then e.amount + e.tax_amount
                                  else -e.amount end), 0), 2)
    from folio_entries e
    join folios f on f.id = e.folio_id
   where e.booking_id = p_booking and e.voided_at is null and f.event_id is null;
$$;

/*
 * A booking that never happened (cancelled, no-show, waitlisted) takes no new
 * charges. Money can still come in for what it owes (a cancellation charge)
 * and go back out as a refund; a penalty and a credit note still post.
 * A checked-out stay still takes charges: they go to its "After invoice" folio.
 */
create or replace function folio_entry_closed_booking()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_status text;
  v_owed   numeric;
begin
  select status::text into v_status from bookings where id = new.booking_id;
  if v_status not in ('cancelled', 'no_show', 'waitlisted') then return new; end if;
  if new.kind in ('refund', 'penalty') or new.credit_note_id is not null then return new; end if;
  if new.kind = 'payment' then
    v_owed := stay_balance(new.booking_id);
    if new.amount <= v_owed + 0.005 then return new; end if;
    raise exception 'BOOKING_CLOSED: this booking is %; it owes %, so only that can be taken',
      replace(v_status, '_', '-'), greatest(v_owed, 0);
  end if;
  raise exception 'BOOKING_CLOSED: this booking is %, so nothing more can be charged to it', replace(v_status, '_', '-');
end;
$$;

drop trigger if exists folio_entries_closed_booking on folio_entries;
create trigger folio_entries_closed_booking
  before insert on folio_entries
  for each row execute function folio_entry_closed_booking();

/*
 * As 0039, plus: a line with no stay date (a payment, a penalty, a paid-out)
 * is dated to the open business date, so the closed-day lock covers it and
 * night audit closes it on its own day.
 */
create or replace function folio_entry_late_posting()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_property uuid := coalesce(new.property_id, current_property());
begin
  if new.kind <> 'room' and new.stay_date is null then
    new.stay_date := (select business_date from properties where id = v_property);
  elsif new.kind <> 'room' and new.stay_date is not null and day_is_closed(v_property, new.stay_date) then
    new.stay_date := (select business_date from properties where id = v_property);
  end if;
  return new;
end;
$$;

/*
 * What can be refunded on a stay: what was paid and not yet refunded, but
 * never more than the stay is in credit. A settled folio has nothing to
 * refund; one in credit after a credit note can refund that credit.
 */
create or replace function refundable_amount(p_booking uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(greatest(least(
    coalesce((select sum(case
                when kind = 'payment' and coalesce(method::text, '') <> 'loyalty_points' then amount
                when kind = 'refund' then -amount
                else 0 end)
                from folio_entries
               where booking_id = p_booking and voided_at is null), 0),
    -stay_balance(p_booking)), 0), 2);
$$;

/* Credit notes against an invoice can never add up to more than the invoice. */
create or replace function credit_note_within_invoice()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_total numeric;
  v_done  numeric;
begin
  select grand_total into v_total from invoices where id = new.invoice_id for update;
  select coalesce(sum(grand_total), 0) into v_done from credit_notes where invoice_id = new.invoice_id;
  if v_done + new.grand_total > coalesce(v_total, 0) + 0.005 then
    raise exception 'CREDIT_NOTE_EXCEEDS_INVOICE: only % of this invoice is left to credit', greatest(round(v_total - v_done, 2), 0);
  end if;
  return new;
end;
$$;

drop trigger if exists credit_notes_within_invoice on credit_notes;
create trigger credit_notes_within_invoice
  before insert on credit_notes
  for each row execute function credit_note_within_invoice();

-- A desk claims a check-out while it runs, so two desks cannot both take the settlement.
alter table bookings add column if not exists checkout_started_at timestamptz;

-- ── POS ─────────────────────────────────────────────────────────────────────

/* A settled or void bill's tip and room are fixed. */
create or replace function pos_order_settled_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('settled', 'void')
     and (new.tip_amount is distinct from old.tip_amount or new.room_id is distinct from old.room_id) then
    raise exception 'POS_ORDER_SETTLED: this bill is %; its tip and room can no longer change', old.status;
  end if;
  return new;
end;
$$;

drop trigger if exists pos_orders_settled_guard on pos_orders;
create trigger pos_orders_settled_guard
  before update on pos_orders
  for each row execute function pos_order_settled_guard();

/* A line voided off a part-paid bill can leave nothing owing: the bill is then settled. */
create or replace function pos_line_void_settles()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.voided_at is null and new.voided_at is not null
     and (select status from pos_orders where id = new.order_id) = 'billed'
     and pos_order_balance(new.order_id) <= 0.005 then
    update pos_orders set status = 'settled', closed_at = now() where id = new.order_id;
  end if;
  return null;
end;
$$;

-- Named to run after pos_order_lines_recalc, which brings the bill's totals up to date.
drop trigger if exists pos_order_lines_status on pos_order_lines;
create trigger pos_order_lines_status
  after update of voided_at on pos_order_lines
  for each row execute function pos_line_void_settles();

-- ── Rates: a promo code's limits hold even when two bookings use it at once ─

create or replace function promo_redemption_limits()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_code promo_codes;
  v_used int;
begin
  select * into v_code from promo_codes where id = new.promo_code_id for update;
  if v_code.max_redemptions is not null then
    select count(*) into v_used from promo_redemptions where promo_code_id = new.promo_code_id;
    if v_used >= v_code.max_redemptions then
      raise exception 'PROMO_USED_UP: % has been used % time(s), its limit', v_code.code, v_used;
    end if;
  end if;
  if v_code.max_per_guest is not null and (new.guest_id is not null or coalesce(new.email, '') <> '') then
    select count(*) into v_used from promo_redemptions
     where promo_code_id = new.promo_code_id
       and ((new.guest_id is not null and guest_id = new.guest_id)
            or (coalesce(new.email, '') <> '' and lower(email) = lower(new.email)));
    if v_used >= v_code.max_per_guest then
      raise exception 'PROMO_USED_UP: this guest has already used % % time(s)', v_code.code, v_used;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists promo_redemptions_limits on promo_redemptions;
create trigger promo_redemptions_limits
  before insert on promo_redemptions
  for each row execute function promo_redemption_limits();

-- ── Admin ───────────────────────────────────────────────────────────────────

/* As 0024, plus: a closed hotel cannot be switched into. */
create or replace function set_active_property(p_property uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not is_staff() then
    raise exception 'not permitted';
  end if;
  if p_property is not null and p_property not in (select staff_property_ids()) then
    raise exception 'PROPERTY_NOT_YOURS' using hint = 'You do not have access to that property.';
  end if;
  if p_property is not null and not exists (select 1 from properties where id = p_property and is_active) then
    raise exception 'PROPERTY_CLOSED: that hotel is closed';
  end if;
  update staff set active_property_id = p_property where id = auth.uid();
end;
$$;

-- Someone who manages properties can save them (it said "Saved." and wrote nothing).
drop policy if exists properties_update on properties;
create policy properties_update on properties for update
  using ((has_permission('settings.manage') or has_permission('properties.manage'))
         and id in (select staff_property_ids()))
  with check ((has_permission('settings.manage') or has_permission('properties.manage'))
              and id in (select staff_property_ids()));

/* Who holds a role, at every hotel: deleting a role used to count only the current one. */
create or replace function role_usage(p_role text)
returns table (property text, staff int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not has_permission('roles.manage') then raise exception 'not permitted'; end if;
  return query
  select coalesce(p.name, 'No hotel'), count(*)::int
    from staff s left join properties p on p.id = s.property_id
   where s.role = p_role
   group by p.name
   order by p.name;
end;
$$;

-- ── Credit notes: "credit the rest" credits what is left on the invoice ─────

/* As 0036, but a full credit stops at what is left of the invoice after allowances and earlier credit notes. */
create or replace function credit_note_issue(
  p_invoice uuid, p_reason_code text, p_note text default '', p_lines jsonb default null
) returns credit_notes
language plpgsql volatile security definer set search_path = public as $$
declare
  v_inv        invoices;
  v_today      date := local_day(now());
  v_line       jsonb;
  v_idx        int;
  v_total      numeric;
  v_cr_total   numeric;
  v_cr_net     numeric;
  v_cr_tax     numeric;
  v_left       numeric;
  v_req        numeric;
  v_rate       numeric;
  v_net        numeric;
  v_tax        numeric;
  v_cgst       numeric;
  v_sgst       numeric;
  v_igst       numeric;
  v_lines      jsonb := '[]';
  v_requested  numeric := 0;
  v_used       numeric := 0;
  v_prefix     text;
  v_inv_prefix text;
  v_fy         text;
  v_seq        int;
  v_cn         credit_notes;
  v_budget     numeric;
begin
  if not has_permission('folio.credit_note') then
    raise exception 'not permitted';
  end if;

  select * into v_inv from invoices where id = p_invoice for update;
  if v_inv.id is null or not can_access_property(v_inv.property_id) then
    raise exception 'CREDIT_NOTE_NO_INVOICE: invoice not found';
  end if;
  if v_inv.status <> 'issued' then
    raise exception 'CREDIT_NOTE_INVOICE_CANCELLED: % is cancelled', v_inv.number;
  end if;
  if p_reason_code is null
     or p_reason_code not in ('deficiency', 'discount', 'cancellation', 'billing_error', 'other') then
    raise exception 'CREDIT_NOTE_REASON: choose a reason';
  end if;
  if v_today > credit_note_deadline(local_day(v_inv.issued_at)) then
    raise exception 'CREDIT_NOTE_TIME_LIMIT: credit notes against % had to be issued by %',
      v_inv.number, to_char(credit_note_deadline(local_day(v_inv.issued_at)), 'DD Mon YYYY');
  end if;

  if p_lines is not null then
    select coalesce(sum((x ->> 'amount')::numeric), 0) into v_requested
      from jsonb_array_elements(p_lines) x
     where coalesce((x ->> 'amount')::numeric, 0) > 0;
    if v_requested <= 0 then
      raise exception 'CREDIT_NOTE_NOTHING: enter an amount to credit';
    end if;
  end if;

  -- 0043: never more than is left of the invoice itself. Its lines include
  -- allowances (negative), so crediting every positive line in full used to
  -- credit more than the invoice was for.
  v_budget := round(v_inv.grand_total - coalesce((select sum(grand_total) from credit_notes where invoice_id = p_invoice), 0), 2);

  for v_line, v_idx in
    select value, (ordinality - 1)::int from jsonb_array_elements(v_inv.lines) with ordinality
  loop
    v_total := coalesce((v_line ->> 'total')::numeric, 0);
    continue when v_total <= 0;

    select coalesce(sum((l ->> 'total')::numeric), 0),
           coalesce(sum((l ->> 'net')::numeric), 0),
           coalesce(sum((l ->> 'tax')::numeric), 0)
      into v_cr_total, v_cr_net, v_cr_tax
      from credit_notes c, jsonb_array_elements(c.lines) l
     where c.invoice_id = p_invoice and (l ->> 'line')::int = v_idx;

    v_left := round(v_total - v_cr_total, 2);
    continue when v_left <= 0;

    if p_lines is null then
      v_req := least(v_left, v_budget - v_used);
    else
      select coalesce(sum((x ->> 'amount')::numeric), 0) into v_req
        from jsonb_array_elements(p_lines) x
       where (x ->> 'line')::int = v_idx;
      v_req := round(v_req, 2);
    end if;
    continue when v_req <= 0;

    if v_req > v_left + 0.005 then
      raise exception 'CREDIT_NOTE_EXCEEDS_LINE: % has only % left to credit',
        coalesce(v_line ->> 'description', 'that line'), v_left;
    end if;

    v_rate := coalesce((v_line ->> 'tax_rate')::numeric, 0);
    if v_req >= v_left - 0.005 then
      -- The rest of the line: take exactly what is left, so the line nets to zero.
      v_net := round(coalesce((v_line ->> 'net')::numeric, 0) - v_cr_net, 2);
      v_tax := round(coalesce((v_line ->> 'tax')::numeric, 0) - v_cr_tax, 2);
      v_req := v_net + v_tax;
    else
      v_net := round(v_req / (1 + v_rate / 100), 2);
      v_tax := round(v_req - v_net, 2);
    end if;

    v_cgst := 0; v_sgst := 0; v_igst := 0;
    if v_inv.tax_regime = 'gst' then
      if v_inv.is_interstate then
        v_igst := v_tax;
      else
        v_cgst := round(v_tax / 2, 2);
        v_sgst := v_tax - v_cgst;
      end if;
    end if;

    v_used := v_used + v_req;
    v_lines := v_lines || jsonb_build_object(
      'line', v_idx,
      'date', v_line ->> 'date',
      'description', coalesce(v_line ->> 'description', ''),
      'sac', coalesce(v_line ->> 'sac', ''),
      'dept', v_line ->> 'dept',
      'rate', v_rate,
      'net', v_net, 'tax', v_tax,
      'cgst', v_cgst, 'sgst', v_sgst, 'igst', v_igst,
      'total', v_req);
  end loop;

  if p_lines is not null and abs(v_used - v_requested) > 0.005 then
    raise exception 'CREDIT_NOTE_BAD_LINE: one of the lines chosen is not on % or has nothing left to credit',
      v_inv.number;
  end if;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'CREDIT_NOTE_NOTHING: nothing on % is left to credit', v_inv.number;
  end if;

  select credit_note_prefix, invoice_prefix into v_prefix, v_inv_prefix
    from properties where id = v_inv.property_id;
  v_prefix := coalesce(nullif(v_prefix, ''), 'CN');
  if v_prefix = coalesce(nullif(v_inv_prefix, ''), 'INV') then
    raise exception 'CREDIT_NOTE_SERIES: the credit-note prefix must differ from the invoice prefix (Settings)';
  end if;

  v_fy := financial_year_of(v_today);
  insert into invoice_series (property_id, series, financial_year, last_seq)
  values (v_inv.property_id, v_prefix, v_fy, 1)
  on conflict (property_id, series, financial_year)
    do update set last_seq = invoice_series.last_seq + 1
  returning last_seq into v_seq;

  insert into credit_notes (
    property_id, number, series, financial_year, seq,
    invoice_id, booking_id, folio_id, event_id, reason_code, note,
    bill_to_name, bill_to_address, bill_to_gstin, bill_to_state_code, place_of_supply,
    tax_regime, is_interstate, currency,
    net_total, tax_total, cgst_total, sgst_total, igst_total, grand_total,
    tax_breakdown, lines, issued_by
  )
  select
    v_inv.property_id, v_prefix || '/' || v_fy || '/' || lpad(v_seq::text, 4, '0'), v_prefix, v_fy, v_seq,
    v_inv.id, v_inv.booking_id, v_inv.folio_id, v_inv.event_id, p_reason_code, coalesce(btrim(p_note), ''),
    v_inv.bill_to_name, v_inv.bill_to_address, v_inv.bill_to_gstin, v_inv.bill_to_state_code, v_inv.place_of_supply,
    v_inv.tax_regime, v_inv.is_interstate, v_inv.currency,
    sum((l ->> 'net')::numeric), sum((l ->> 'tax')::numeric),
    sum((l ->> 'cgst')::numeric), sum((l ->> 'sgst')::numeric), sum((l ->> 'igst')::numeric),
    sum((l ->> 'total')::numeric),
    (select coalesce(jsonb_agg(b order by b ->> 'sac', (b ->> 'rate')::numeric), '[]')
       from (select jsonb_build_object(
                      'sac', l2 ->> 'sac', 'rate', (l2 ->> 'rate')::numeric,
                      'net', sum((l2 ->> 'net')::numeric), 'tax', sum((l2 ->> 'tax')::numeric),
                      'cgst', sum((l2 ->> 'cgst')::numeric), 'sgst', sum((l2 ->> 'sgst')::numeric),
                      'igst', sum((l2 ->> 'igst')::numeric)) as b
               from jsonb_array_elements(v_lines) l2
              group by l2 ->> 'sac', (l2 ->> 'rate')::numeric) bands),
    v_lines, auth.uid()
  from jsonb_array_elements(v_lines) l
  returning * into v_cn;

  -- The guest owes that much less. An overpaid folio is then refunded through
  -- the usual refund request.
  if v_inv.folio_id is not null then
    insert into folio_entries (property_id, booking_id, folio_id, kind, description, amount, reference,
                               credit_note_id, created_by)
    values (v_inv.property_id, v_inv.booking_id, v_inv.folio_id, 'adjustment',
            'Credit note ' || v_cn.number || ' against ' || v_inv.number,
            v_cn.grand_total, v_cn.number, v_cn.id, auth.uid());
  end if;

  return v_cn;
end;
$$;

-- ── Reports ─────────────────────────────────────────────────────────────────

-- The manager's flash report (0037) can be emailed on a schedule too.
alter table report_schedules drop constraint if exists report_schedules_report_check;
alter table report_schedules add constraint report_schedules_report_check
  check (report in ('daily_revenue', 'kpi_summary', 'flash', 'outstanding', 'outlet_sales', 'housekeeping', 'maintenance'));
