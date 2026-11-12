-- ============================================================================
-- Assertions for 0040_fix_first.sql: the database half of the "Fix these
-- first" list in docs/interconnection-audit-2026-11-07.md. Runs after
-- fixes.sql and reuses behaviour.sql's fixtures (property H1 and DL, the
-- premier and luxury room types, the RST outlet and its bottled water
-- 00000000-...-00e6, administrator 00000000-...-0001).
--
-- Every check is an ASSERT, so a clean exit means all passed.
-- ============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

reset role;
-- Rooms of their own, so nothing else in the suite clashes with them.
insert into rooms (room_number, room_type_id, floor, status, housekeeping_status, property_id)
select x.n, rt.id, 9, 'available', 'inspected', rt.property_id
  from (values ('F01', 'premier-room'), ('F02', 'premier-room'), ('F03', 'premier-room'),
               ('F11', 'luxury-room')) as x (n, slug)
  join room_types rt on rt.slug = x.slug
  join properties p on p.id = rt.property_id and p.code = 'H1';

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
set role authenticated;
select set_active_property((select id from properties where code = 'H1')) is null as h1;

-- ── 3. Outlet and event postings to a stay that is already invoiced ─────────
\echo 'F3. part-paid outlet bills and events with a deposit post to the "After invoice" folio'
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name)
select rt.id, r.id, current_date - 1, current_date + 2, 'checked_in', 'F3 Invoiced Stay'
  from room_types rt join rooms r on r.room_type_id = rt.id and r.room_number = 'F01'
 where rt.slug = 'premier-room' and rt.property_id = current_property();
do $$
declare
  b uuid := (select id from bookings where contact_name = 'F3 Invoiced Stay');
  master uuid := master_folio((select id from bookings where contact_name = 'F3 Invoiced Stay'));
  o uuid; after uuid; ev uuid;
begin
  insert into folio_entries (booking_id, kind, description, amount) values (b, 'extra', 'Before the invoice', 100);
  insert into invoices (number, series, financial_year, seq, booking_id, folio_id, bill_to_name, net_total, tax_total, grand_total)
  values ('F3/2026-27/0001', 'F3', '2026-27', 1, b, master, 'F3', 100, 0, 100);

  o := pos_open_order((select id from pos_outlets where code = 'RST' and property_id = current_property()), 'F3');
  perform pos_add_line(o, '00000000-0000-0000-0000-0000000000e6', 2);
  perform pos_take_payment(o, 'cash', 50);
  perform pos_charge_to_room(o, b);   -- refused with FOLIO_INVOICED before 0040

  after := (select folio_id from folio_entries
             where booking_id = b and reference = (select number from pos_orders where id = o) and kind = 'extra' limit 1);
  assert after <> master, 'the outlet lines should not land on the invoiced folio';
  assert not exists (select 1 from folio_entries
                      where reference = (select number from pos_orders where id = o) and folio_id <> after),
    'the outlet lines and the "already paid" credit should all be on one folio';
  assert (select folio_id from pos_payments where order_id = o and kind = 'room_charge') = after,
    'the room-charge payment should record the folio the lines went to';

  -- An event with a deposit, billed to the same invoiced stay.
  insert into event_bookings (number, financial_year, seq, space_id, title, contact_name,
    event_date, start_time, end_time, setup_from, teardown_to, pax_expected, status, created_by)
  values ('EVT/F3/0001', '2026-27', 9930, (select id from event_spaces where code = 'HALL' and property_id = current_property()),
    'F3 dinner', 'F3', current_date + 100, '19:00', '22:00', '18:00', '22:30', 10, 'confirmed',
    '00000000-0000-0000-0000-000000000001')
  returning id into ev;
  insert into event_lines (event_id, kind, description, qty, unit_price) values (ev, 'other', 'Hall rental', 1, 3000);
  perform event_take_payment(ev, 'advance', 'card', 500);
  perform event_post_to_folio(ev, b);  -- refused with FOLIO_INVOICED before 0040
  assert not exists (select 1 from folio_entries where reference = 'EVT/F3/0001' and folio_id = master),
    'the event lines and its deposit credit should not land on the invoiced folio';
  assert (select folio_id from event_payments where event_id = ev and kind = 'room_charge')
       = (select folio_id from folio_entries where reference = 'EVT/F3/0001' and kind = 'extra' limit 1),
    'the event room-charge payment should record the folio its lines went to';
end;
$$;

-- ── 4. One issued invoice per folio ─────────────────────────────────────────
\echo 'F4. a folio cannot carry two issued invoices'
do $$
declare
  b uuid := (select id from bookings where contact_name = 'F3 Invoiced Stay');
  msg text := '';
begin
  begin
    insert into invoices (number, series, financial_year, seq, booking_id, folio_id, bill_to_name, net_total, tax_total, grand_total)
    values ('F3/2026-27/0002', 'F3', '2026-27', 2, b, master_folio(b), 'F3', 100, 0, 100);
  exception when unique_violation then msg := 'unique';
  end;
  assert msg = 'unique', 'a second issued invoice on the same folio should be refused';
end;
$$;

-- ── 6. Night audit closes only the lines that belong to the day ─────────────
\echo 'F6. close_folio_day leaves lines for later nights open'
-- Separate statements: close_folio_day only takes lines created before its
-- own transaction began.
insert into folio_entries (booking_id, kind, description, amount, stay_date)
select id, 'extra', 'F6 pre-posted for a later night', 70, current_date + 20 from bookings where contact_name = 'F3 Invoiced Stay';
insert into folio_entries (booking_id, kind, description, amount)
select id, 'extra', 'F6 posted today', 30 from bookings where contact_name = 'F3 Invoiced Stay';
select close_folio_day(current_date) > 0 as closed;
do $$
begin
  assert (select night_audit_date from folio_entries where description = 'F6 pre-posted for a later night') is null,
    'a line for a later night should not be stamped onto today''s audit';
  assert (select night_audit_date from folio_entries where description = 'F6 posted today') = current_date,
    'today''s line should be stamped';
end;
$$;

-- ── 9. A room's type follows the room ───────────────────────────────────────
\echo 'F9. moving a guest into a room of another type changes the booking''s type and checks its capacity'
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name)
select rt.id, r.id, current_date, current_date + 2, 'checked_in', 'F9 Upgrade'
  from room_types rt join rooms r on r.room_type_id = rt.id and r.room_number = 'F02'
 where rt.slug = 'premier-room' and rt.property_id = current_property();
do $$
declare
  luxury uuid := (select id from room_types where slug = 'luxury-room' and property_id = current_property());
  msg text := '';
begin
  update bookings set room_id = (select id from rooms where room_number = 'F11') where contact_name = 'F9 Upgrade';
  assert (select room_type_id from bookings where contact_name = 'F9 Upgrade') = luxury,
    'an upgraded booking should take the new room''s type';

  -- Luxury has one room and the upgraded guest is in it tonight.
  begin
    insert into bookings (room_type_id, check_in, check_out, status, contact_name)
    values (luxury, current_date, current_date + 1, 'confirmed', 'F9 Oversell');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'OVERBOOKED%', 'luxury is full tonight after the upgrade: expected OVERBOOKED, got [' || msg || ']';
end;
$$;

-- ── 10. A split stay hands its room over; a turnover keeps the room occupied ─
\echo 'F10. checking out part 1 of a split stay checks part 2 in, in the same room'
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name)
select rt.id, r.id, current_date - 2, current_date, 'checked_in', 'F10 Part 1'
  from room_types rt join rooms r on r.room_type_id = rt.id and r.room_number = 'F03'
 where rt.slug = 'premier-room' and rt.property_id = current_property();
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name, split_from_id)
select room_type_id, room_id, current_date, current_date + 3, 'confirmed', 'F10 Part 2', id
  from bookings where contact_name = 'F10 Part 1';
do $$
declare
  room uuid := (select room_id from bookings where contact_name = 'F10 Part 1');
  tasks_before int := (select count(*) from housekeeping_tasks where room_id = (select room_id from bookings where contact_name = 'F10 Part 1'));
begin
  update bookings set status = 'checked_out', checked_out_at = now() where contact_name = 'F10 Part 1';
  assert (select status from bookings where contact_name = 'F10 Part 2') = 'checked_in',
    'part 2 should be checked in when part 1 checks out';
  assert (select status from rooms where id = room) = 'occupied', 'the room should stay occupied';
  assert (select housekeeping_status from rooms where id = room) <> 'dirty', 'the room should not be dirtied';
  assert (select count(*) from housekeeping_tasks where room_id = room) = tasks_before,
    'no check-out clean should be raised for a room the guest is still in';
end;
$$;

\echo 'F10b. a same-day turnover does not free a room the next guest is already in'
-- F10 Part 2 is in F03 now. Another stay that also held F03 until today
-- leaves: the room must stay occupied because Part 2 is still in it.
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name)
select room_type_id, room_id, current_date - 1, current_date, 'checked_in', 'F10b Leaver'
  from bookings where contact_name = 'F10 Part 2';
update bookings set status = 'checked_out' where contact_name = 'F10b Leaver';
do $$
begin
  assert (select status from rooms where room_number = 'F03') = 'occupied',
    'the room should stay occupied while another guest is checked in to it';
end;
$$;

-- ── 11. Event money reaches the cashier, and a cancelled event leaves the folio ─
\echo 'F11. event cash is on the cashier''s shift and in the payments report'
do $$
declare
  ev uuid; shift uuid; before_expected numeric; before_taken numeric;
begin
  if my_open_shift() is null then
    perform cashier_open_shift(0);
  end if;
  shift := my_open_shift();
  before_expected := cashier_shift_expected(shift);
  before_taken := coalesce((select sum(taken) from report_payments(current_date, current_date)), 0);

  insert into event_bookings (number, financial_year, seq, space_id, title, contact_name,
    event_date, start_time, end_time, setup_from, teardown_to, pax_expected, status, created_by)
  values ('EVT/F11/0001', '2026-27', 9931, (select id from event_spaces where code = 'HALL' and property_id = current_property()),
    'F11 seminar', 'F11', current_date + 110, '09:00', '12:00', '08:00', '12:30', 10, 'confirmed',
    '00000000-0000-0000-0000-000000000001')
  returning id into ev;
  insert into event_lines (event_id, kind, description, qty, unit_price) values (ev, 'other', 'Hall rental', 1, 8000);
  perform event_take_payment(ev, 'advance', 'cash', 5000);

  assert (select shift_id from event_payments where event_id = ev and kind = 'advance') = shift,
    'a cash event deposit should be tagged with the cashier''s open shift';
  assert cashier_shift_expected(shift) = before_expected + 5000,
    'the drawer should expect the event deposit, got ' || cashier_shift_expected(shift) || ' from ' || before_expected;
  assert coalesce((select sum(taken) from report_payments(current_date, current_date)), 0) = before_taken + 5000,
    'the payments report should include the event deposit';
end;
$$;

\echo 'F11b. cancelling an event charged to a room voids its folio lines'
insert into bookings (room_type_id, check_in, check_out, status, contact_name)
select id, current_date - 1, current_date + 1, 'checked_in', 'F11 Resident'
  from room_types where slug = 'premier-room' and property_id = current_property();
do $$
declare
  b uuid := (select id from bookings where contact_name = 'F11 Resident');
  ev uuid;
begin
  insert into event_bookings (number, financial_year, seq, space_id, title, contact_name,
    event_date, start_time, end_time, setup_from, teardown_to, pax_expected, status, created_by)
  values ('EVT/F11/0002', '2026-27', 9932, (select id from event_spaces where code = 'HALL' and property_id = current_property()),
    'F11 cancelled', 'F11', current_date + 111, '09:00', '12:00', '08:00', '12:30', 10, 'confirmed',
    '00000000-0000-0000-0000-000000000001')
  returning id into ev;
  insert into event_lines (event_id, kind, description, qty, unit_price) values (ev, 'other', 'Hall rental', 1, 4000);
  perform event_post_to_folio(ev, b);
  assert exists (select 1 from folio_entries where reference = 'EVT/F11/0002' and voided_at is null), 'fixture: the event should be on the folio';

  perform event_cancel(ev, 'Client called it off');
  assert not exists (select 1 from folio_entries where reference = 'EVT/F11/0002' and voided_at is null),
    'a cancelled event should leave no live lines on the guest''s folio';
  assert not exists (select 1 from event_payments where event_id = ev and kind = 'room_charge' and voided_at is null),
    'the room-charge transfer should be voided too';
end;
$$;

-- ── 12. Losing access to a hotel ends work there ────────────────────────────
\echo 'F12. a stale active property falls back to the person''s own hotel'
reset role;
update staff set all_properties = false, property_id = (select id from properties where code = 'H1'),
                 active_property_id = (select id from properties where code = 'DL')
 where id = '00000000-0000-0000-0000-000000000007';
delete from staff_properties where staff_id = '00000000-0000-0000-0000-000000000007';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000007', false);
set role authenticated;
do $$
begin
  assert current_property() = (select id from properties where code = 'H1'),
    'without access to DL, current_property() should be the home hotel';
  assert not exists (select 1 from bookings b join properties p on p.id = b.property_id where p.code = 'DL'),
    'DL bookings should not be visible any more';
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;

-- ── 13. Removing staff keeps their history ──────────────────────────────────
\echo 'F13. removing someone with history deactivates them; someone without history is deleted'
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f1', 'f13-worked@x.test'),
  ('00000000-0000-0000-0000-0000000000f2', 'f13-new@x.test');
insert into staff (id, email, full_name, role, property_id)
select u.id, u.email, u.email, 'front_desk', (select id from properties where code = 'H1')
  from auth.users u where u.id in ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2')
on conflict (id) do update set role = excluded.role, property_id = excluded.property_id;
insert into folio_entries (booking_id, kind, description, amount, created_by)
values ((select id from bookings where contact_name = 'F11 Resident'), 'extra', 'Posted by F13', 10,
        '00000000-0000-0000-0000-0000000000f1');
set role authenticated;
do $$
declare r text;
begin
  r := staff_remove('00000000-0000-0000-0000-0000000000f1');
  assert r = 'deactivated', 'someone with folio history should be deactivated, got ' || coalesce(r, 'null');
  assert (select not is_active and sessions_revoked_at is not null from staff
           where id = '00000000-0000-0000-0000-0000000000f1'), 'they should be inactive and signed out';

  r := staff_remove('00000000-0000-0000-0000-0000000000f2');
  assert r = 'deleted', 'someone with no history should be deleted, got ' || coalesce(r, 'null');
end;
$$;
reset role;
do $$
begin
  assert not exists (select 1 from auth.users where id = '00000000-0000-0000-0000-0000000000f2'), 'the sign-in should be gone';
  assert exists (select 1 from folio_entries where created_by = '00000000-0000-0000-0000-0000000000f1'),
    'the deactivated person''s postings should keep their name';
end;
$$;

\echo 'ALL 0040 ASSERTIONS PASSED'
