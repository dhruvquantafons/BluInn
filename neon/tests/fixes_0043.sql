-- ============================================================================
-- Assertions for 0043_validations_and_links.sql: the database half of
-- sections 1, 3 and 4 of docs/interconnection-audit-2026-11-12.md (missing
-- validations, dead buttons). Runs after fixes_0042.sql and reuses the fixtures
-- of behaviour.sql and the earlier fix files (H1, DL, RST and its bottled water
-- ...00e6, administrator ...01, rooms G01-G03).
-- Every check is an ASSERT, so a clean exit means all passed.
-- ============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

reset role;
select set_config('request.jwt.claims', '', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
set role authenticated;
select set_active_property((select id from properties where code = 'H1')) is null as h1;

-- ── Folio ───────────────────────────────────────────────────────────────────
\echo 'V1. a cancelled booking takes no new charges, and only what it owes in payments; a checked-out stay still takes charges'
insert into bookings (room_type_id, check_in, check_out, status, contact_name)
select id, current_date + 60, current_date + 62, 'confirmed', 'V1 Cancelled'
  from room_types where slug = 'premier-room' and property_id = current_property();
insert into bookings (room_type_id, check_in, check_out, status, contact_name)
select id, current_date - 3, current_date - 1, 'checked_out', 'V1 Departed'
  from room_types where slug = 'premier-room' and property_id = current_property();
insert into folio_entries (booking_id, kind, description, amount, method)
select id, 'payment', 'V1 deposit', 2000, 'card' from bookings where contact_name = 'V1 Cancelled';
update bookings set status = 'cancelled', cancelled_at = now(), cancellation_reason = 'V1' where contact_name = 'V1 Cancelled';
do $$
declare b uuid := (select id from bookings where contact_name = 'V1 Cancelled'); msg text := '';
begin
  begin
    insert into folio_entries (booking_id, kind, description, amount) values (b, 'extra', 'V1 minibar', 500);
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'BOOKING_CLOSED%', 'a charge on a cancelled booking: expected BOOKING_CLOSED, got [' || msg || ']';
  msg := '';
  begin
    insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'payment', 'V1 more', 100, 'cash');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'BOOKING_CLOSED%', 'a payment when nothing is owed: expected BOOKING_CLOSED, got [' || msg || ']';
  -- The deposit can be refunded.
  insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'refund', 'V1 deposit back', 2000, 'card');
  -- A checked-out stay still takes a late charge.
  insert into folio_entries (booking_id, kind, description, amount)
  select id, 'extra', 'V1 minibar found after departure', 120 from bookings where contact_name = 'V1 Departed';
end;
$$;

\echo 'V2. a payment with no stay date is dated to the open business date'
do $$
declare d date;
begin
  insert into folio_entries (booking_id, kind, description, amount, method)
  select id, 'payment', 'V2 payment', 50, 'cash' from bookings where contact_name = 'V1 Departed'
  returning stay_date into d;
  assert d = (select business_date from properties where id = current_property()),
    'an undated payment should take the business date, got ' || coalesce(d::text, 'null');
end;
$$;

\echo 'V3. a refund cannot exceed what the guest is owed back'
insert into bookings (room_type_id, check_in, check_out, status, contact_name)
select id, current_date - 2, current_date, 'checked_out', 'V3 Settled'
  from room_types where slug = 'premier-room' and property_id = current_property();
do $$
declare b uuid := (select id from bookings where contact_name = 'V3 Settled'); msg text := '';
begin
  insert into folio_entries (booking_id, kind, description, amount) values (b, 'extra', 'V3 stay', 1000);
  insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'payment', 'V3 paid', 1000, 'card');
  begin
    insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'refund', 'V3 too much', 100, 'card');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'REFUND_EXCEEDS_PAID%', 'a refund on a settled folio: expected REFUND_EXCEEDS_PAID, got [' || msg || ']';
end;
$$;

\echo 'V4. credit notes cannot add up to more than the invoice'
reset role;
insert into invoices (number, series, financial_year, seq, booking_id, folio_id, bill_to_name, net_total, tax_total, grand_total, property_id)
select 'V4/2026-27/0001', 'V4', '2026-27', 1, b.id, master_folio(b.id), 'V4', 800, 0, 800, b.property_id
  from bookings b where b.contact_name = 'V3 Settled';
do $$
declare msg text := '';
begin
  begin
    insert into credit_notes (number, series, financial_year, seq, invoice_id, booking_id, reason_code,
                              bill_to_name, net_total, tax_total, grand_total, property_id, tax_regime, lines)
    select 'V4CN/2026-27/0001', 'V4CN', '2026-27', 1, i.id, i.booking_id, 'discount', 'V4', 1000, 0, 1000,
           i.property_id, 'gst', '[]'::jsonb
      from invoices i where i.number = 'V4/2026-27/0001';
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'CREDIT_NOTE_EXCEEDS_INVOICE%', 'crediting 1000 on an 800 invoice: expected CREDIT_NOTE_EXCEEDS_INVOICE, got [' || msg || ']';
end;
$$;
set role authenticated;

-- ── POS ─────────────────────────────────────────────────────────────────────
\echo 'V5. a settled bill''s tip and room cannot be changed'
do $$
declare o uuid; msg text := '';
begin
  o := pos_open_order((select id from pos_outlets where code = 'RST' and property_id = current_property()), 'V5');
  perform pos_add_line(o, '00000000-0000-0000-0000-0000000000e6', 1);
  perform pos_take_payment(o, 'cash', pos_order_balance(o));
  begin
    update pos_orders set tip_amount = 500 where id = o;
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'POS_ORDER_SETTLED%', 'a tip added to a settled bill: expected POS_ORDER_SETTLED, got [' || msg || ']';
end;
$$;

\echo 'V6. voiding a line on a part-paid bill settles it once nothing is owed'
do $$
declare o uuid; l2 uuid;
begin
  o := pos_open_order((select id from pos_outlets where code = 'RST' and property_id = current_property()), 'V6');
  perform pos_add_line(o, '00000000-0000-0000-0000-0000000000e6', 1);
  l2 := pos_add_line(o, '00000000-0000-0000-0000-0000000000e6', 1);
  perform pos_take_payment(o, 'cash', round(pos_order_balance(o) / 2, 2));
  assert (select status from pos_orders where id = o) = 'billed', 'fixture: the bill should be part paid';
  update pos_order_lines set voided_at = now(), void_reason = 'V6 not served' where id = l2;
  assert (select status from pos_orders where id = o) = 'settled',
    'with nothing left owing the bill should be settled, is ' || (select status from pos_orders where id = o);
end;
$$;

\echo 'V7. the room-charge limit counts only what the stay still owes'
reset role;
update properties set pos_room_charge_limit = 1000 where code = 'H1';
insert into rooms (room_number, room_type_id, floor, status, housekeeping_status, property_id)
select 'V07', rt.id, 9, 'available', 'inspected', rt.property_id
  from room_types rt join properties p on p.id = rt.property_id and p.code = 'H1' where rt.slug = 'premier-room';
set role authenticated;
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name)
select room_type_id, id, current_date - 1, current_date + 3, 'checked_in', 'V7 Diner' from rooms where room_number = 'V07';
do $$
declare
  b uuid := (select id from bookings where contact_name = 'V7 Diner');
  rst uuid := (select id from pos_outlets where code = 'RST' and property_id = current_property());
  o1 uuid; o2 uuid;
begin
  if b is null then
    reset role;
    raise exception 'fixture: room G01 is taken';
  end if;
  o1 := pos_open_order(rst, 'V7a');
  perform pos_add_line(o1, '00000000-0000-0000-0000-0000000000e6', 8);
  perform pos_charge_to_room(o1, b);
  -- The guest settles the folio.
  insert into folio_entries (booking_id, kind, description, amount, method)
  values (b, 'payment', 'V7 settles', folio_balance_of(master_folio(b)), 'card');
  o2 := pos_open_order(rst, 'V7b');
  perform pos_add_line(o2, '00000000-0000-0000-0000-0000000000e6', 2);
  perform pos_charge_to_room(o2, b);  -- refused before 0043: 928 + 232 > 1000
end;
$$;
reset role;
update properties set pos_room_charge_limit = 0 where code = 'H1';
set role authenticated;

-- ── Rates ───────────────────────────────────────────────────────────────────
\echo 'V9. a promo code cannot be used more times than its limit'
reset role;
insert into promo_codes (code, name, discount_kind, discount_value, max_redemptions, property_id, valid_from, valid_to)
select 'V9ONCE', 'V9 once only', 'percent', 10, 1, id, current_date - 1, current_date + 365 from properties where code = 'H1';
insert into bookings (room_type_id, check_in, check_out, status, contact_name, property_id)
select id, current_date + 90 + n, current_date + 91 + n, 'confirmed', 'V9 Guest ' || n, property_id
  from room_types, generate_series(1, 2) n where slug = 'premier-room' and property_id = (select id from properties where code = 'H1');
do $$
declare msg text := '';
begin
  insert into promo_redemptions (promo_code_id, booking_id, discount_amount)
  select (select id from promo_codes where code = 'V9ONCE'), id, 100 from bookings where contact_name = 'V9 Guest 1';
  begin
    insert into promo_redemptions (promo_code_id, booking_id, discount_amount)
    select (select id from promo_codes where code = 'V9ONCE'), id, 100 from bookings where contact_name = 'V9 Guest 2';
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'PROMO_USED_UP%', 'a second use of a one-use code: expected PROMO_USED_UP, got [' || msg || ']';
end;
$$;
set role authenticated;

-- ── HR ──────────────────────────────────────────────────────────────────────
\echo 'V10. a timesheet cannot claim more hours than were worked'
do $$
declare
  wk date := date_trunc('week', current_date - 14)::date;
  days jsonb := (select jsonb_agg(jsonb_build_object('date', wk + n)) from generate_series(0, 6) n);
  msg text := '';
begin
  begin
    perform timesheet_submit(wk, 'V10', 40, 500, 0, days);
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'TIMESHEET_HOURS%', '540 hours against none worked: expected TIMESHEET_HOURS, got [' || msg || ']';
end;
$$;

\echo 'V11. a night-shift worker can clock out after their week is approved'
reset role;
delete from attendance where staff_id = '00000000-0000-0000-0000-000000000002' and clock_out is null;
insert into attendance (staff_id, work_date, clock_in, method, property_id)
select '00000000-0000-0000-0000-000000000002', date_trunc('week', current_date - 7)::date + 6, now() - interval '3 hours', 'self', id
  from properties where code = 'H1';
insert into timesheets (staff_id, week_start, status, regular_hours, overtime_hours, off_day_hours, days, property_id)
select '00000000-0000-0000-0000-000000000002', date_trunc('week', current_date - 7)::date, 'approved', 0, 0, 0, '[]'::jsonb, id
  from properties where code = 'H1'
on conflict (staff_id, week_start) do update set status = 'approved';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
set role authenticated;
select clock_out() is not null as clocked_out;  -- TIMESHEET_LOCKED before 0043
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

\echo 'V12. someone who can approve timesheets can reopen one'
insert into roles (key, name) values ('v12_approver', 'V12 approver') on conflict do nothing;
insert into role_permissions (role_key, permission) values ('v12_approver', 'hr.approve_time') on conflict do nothing;
update staff set role = 'v12_approver' where id = '00000000-0000-0000-0000-000000000005';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000005', false);
set role authenticated;
select (timesheet_reopen((select id from timesheets where staff_id = '00000000-0000-0000-0000-000000000002'
                           and week_start = date_trunc('week', current_date - 7)::date))).status = 'submitted' as reopened;
reset role;
update staff set role = 'housekeeping_supervisor' where id = '00000000-0000-0000-0000-000000000005';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;

\echo 'V13. leave cannot be booked on a day already worked'
do $$
declare msg text := '';
begin
  begin
    insert into leave_requests (staff_id, kind, start_date, end_date, reason, status)
    values ('00000000-0000-0000-0000-000000000002', 'casual',
            date_trunc('week', current_date - 7)::date + 6, date_trunc('week', current_date - 7)::date + 6, 'V13', 'approved');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'LEAVE_WORKED%', 'leave on a day with attendance: expected LEAVE_WORKED, got [' || msg || ']';
end;
$$;

\echo 'V14. an employee can withdraw their approved leave before it starts'
reset role;
insert into leave_requests (staff_id, kind, start_date, end_date, reason, status, property_id)
select '00000000-0000-0000-0000-000000000002', 'casual', current_date + 30, current_date + 31, 'V14 trip', 'approved', id
  from properties where code = 'H1';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
set role authenticated;
do $$
declare n int;
begin
  update leave_requests set status = 'cancelled'
   where staff_id = auth.uid() and reason = 'V14 trip' and status = 'approved';
  get diagnostics n = row_count;
  assert n = 1, 'the employee should be able to withdraw approved leave that has not started';
end;
$$;

\echo 'V15. clocking out is never blocked by the geofence'
reset role;
update properties set hr_require_geofence = true, hr_geofence_lat = 19.0760, hr_geofence_lng = 72.8777, hr_geofence_radius_m = 200
 where code = 'H1';
delete from attendance where staff_id = '00000000-0000-0000-0000-000000000002' and clock_out is null;
insert into attendance (staff_id, work_date, clock_in, method, property_id)
select '00000000-0000-0000-0000-000000000002', current_date, now() - interval '2 hours', 'self', id from properties where code = 'H1';
set role authenticated;
select clock_out(28.6139, 77.2090) is not null as clocked_out_far_away;  -- GEOFENCE before 0043
reset role;
update properties set hr_require_geofence = false where code = 'H1';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;

\echo 'V16. HR details for someone at another hotel are refused, not silently dropped'
do $$
declare msg text := '';
begin
  begin
    perform set_staff_hr('00000000-0000-0000-0000-0000000000d1', 'X1', null, 'Desk', null, null, null, '', '', '');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'STAFF_NOT_FOUND%', 'a DL staff member while working in H1: expected STAFF_NOT_FOUND, got [' || msg || ']';
end;
$$;

-- ── Admin ───────────────────────────────────────────────────────────────────
\echo 'V17. the switcher refuses a closed hotel'
reset role;
insert into properties (code, name, is_active) values ('V17', 'V17 Closed', false) on conflict do nothing;
set role authenticated;
do $$
declare msg text := '';
begin
  begin
    perform set_active_property((select id from properties where code = 'V17'));
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'PROPERTY_CLOSED%', 'switching to a closed hotel: expected PROPERTY_CLOSED, got [' || msg || ']';
end;
$$;

\echo 'V18. someone with properties.manage can save a property'
reset role;
insert into roles (key, name) values ('v18_props', 'V18 properties') on conflict do nothing;
insert into role_permissions (role_key, permission) values ('v18_props', 'properties.manage') on conflict do nothing;
update staff set role = 'v18_props', all_properties = true where id = '00000000-0000-0000-0000-000000000007';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000007', false);
set role authenticated;
do $$
declare n int;
begin
  update properties set city = city where code = 'H1';
  get diagnostics n = row_count;
  assert n = 1, 'properties.manage should be able to save a property';
end;
$$;
reset role;
update staff set role = 'manager', all_properties = false where id = '00000000-0000-0000-0000-000000000007';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;

\echo 'V19. a role in use at another hotel is reported as in use'
do $$
begin
  assert (select sum(staff) from role_usage('front_desk')) >= 2,
    'front_desk is used at H1 and DL; role_usage should count both';
end;
$$;

\echo 'V20. the flash report can be scheduled'
do $$
begin
  insert into report_schedules (name, report, frequency, recipients, is_active)
  values ('V20 flash', 'flash', 'daily', 'gm@example.com', false);
  delete from report_schedules where name = 'V20 flash';
end;
$$;

\echo 'ALL 0043 ASSERTIONS PASSED'
