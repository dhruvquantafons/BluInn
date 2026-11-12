-- ============================================================================
-- Assertions for 0041_data_flow.sql: the database half of section 2 ("Data
-- that doesn't flow between modules") of docs/interconnection-audit-2026-11-07.md.
-- Runs after fixes_0040.sql and reuses its fixtures (rooms F01-F11, the F3 and
-- F11 stays) and behaviour.sql's (H1, DL, RST, bottled water ...e6, admin ...01).
-- Every check is an ASSERT, so a clean exit means all passed.
-- ============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

reset role;
insert into rooms (room_number, room_type_id, floor, status, housekeeping_status, property_id)
select x.n, rt.id, 9, 'available', 'inspected', rt.property_id
  from (values ('G01'), ('G02'), ('G03')) as x (n)
  join room_types rt on rt.slug = 'premier-room'
  join properties p on p.id = rt.property_id and p.code = 'H1';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
set role authenticated;
select set_active_property((select id from properties where code = 'H1')) is null as h1;

-- ── Rooms, housekeeping and maintenance ─────────────────────────────────────
\echo 'G1. a room can be put out of order today although a later stay is assigned to it'
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name)
select room_type_id, id, current_date + 3, current_date + 5, 'confirmed', 'G1 Later Stay' from rooms where room_number = 'G01';
insert into maintenance_tickets (title, room_id, priority, reported_by)
select 'G1 leak', id, 'urgent', '00000000-0000-0000-0000-000000000001' from rooms where room_number = 'G01';
do $$
declare t uuid := (select id from maintenance_tickets where title = 'G1 leak');
begin
  perform mt_block_room(t);   -- refused with ROOM_IN_USE before 0041
  assert (select status from rooms where room_number = 'G01') = 'out_of_order', 'the room should be out of order';
  assert (select room_id from bookings where contact_name = 'G1 Later Stay') is null,
    'the later stay should be unassigned, to be given another room';
end;
$$;

\echo 'G2. taking a room out of order cancels its open cleaning task'
do $$
declare room uuid := (select id from rooms where room_number = 'G02');
begin
  perform hk_create_task(room, 'checkout', hk_business_today(), 'G2');
  insert into room_blocks (room_id, kind, start_date, reason) values (room, 'out_of_order', current_date, 'G2 broken window');
  update rooms set status = 'out_of_order' where id = room;
  assert not exists (select 1 from housekeeping_tasks where room_id = room and status in ('pending', 'in_progress')),
    'an out-of-order room should have no open cleaning task';
end;
$$;

\echo 'G3. releasing a ticket''s block closes the ticket; reopening it blocks the room again'
do $$
declare t uuid := (select id from maintenance_tickets where title = 'G1 leak');
begin
  update room_blocks set released_at = now(), release_note = 'Fixed, checked from the Rooms page'
   where ticket_id = t and released_at is null;
  assert (select status from maintenance_tickets where id = t) = 'resolved',
    'releasing the block from the Rooms page should resolve its ticket';

  update maintenance_tickets set status = 'open', resolved_at = null where id = t;
  assert exists (select 1 from room_blocks where ticket_id = t and released_at is null),
    'reopening a ticket that took its room out of order should block the room again';
  assert (select status from rooms where room_number = 'G01') = 'out_of_order', 'the room should be out of order again';
end;
$$;

\echo 'G4. daily stay-over cleaning is on for a new property'
do $$
begin
  assert (select column_default from information_schema.columns
           where table_name = 'properties' and column_name = 'hk_stayover_enabled') = 'true',
    'hk_stayover_enabled should default to true';
end;
$$;

-- ── Folio, POS and events ───────────────────────────────────────────────────
\echo 'G5. an outlet bill cannot be charged to another hotel''s guest'
reset role;
insert into pos_outlets (code, name, kind, property_id)
select 'DLR', 'DL Restaurant', 'restaurant', id from properties where code = 'DL';
insert into pos_orders (number, outlet_id, status, net_total, grand_total, property_id)
select 'G5-DL-1', o.id, 'open', 100, 100, o.property_id
  from pos_outlets o join properties p on p.id = o.property_id and p.code = 'DL' limit 1;
insert into pos_order_lines (order_id, name, qty, unit_price, net_amount, tax_amount, tax_rate, property_id)
select id, 'G5 water', 1, 100, 100, 0, 0, property_id from pos_orders where number = 'G5-DL-1';
-- Row security hides DL's bill from an H1 user, so hand its id over directly.
select set_config('fix.g5_order', (select id::text from pos_orders where number = 'G5-DL-1'), false);
set role authenticated;
do $$
declare msg text := '';
begin
  begin
    perform pos_charge_to_room(current_setting('fix.g5_order')::uuid,
                               (select id from bookings where contact_name = 'F11 Resident'));
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'POS_OTHER_PROPERTY%', 'charging a DL bill to an H1 stay: expected POS_OTHER_PROPERTY, got [' || msg || ']';
end;
$$;

\echo 'G6. voiding an outlet bill''s lines on the folio reopens the bill'
insert into bookings (room_type_id, room_id, check_in, check_out, status, contact_name)
select room_type_id, id, current_date - 1, current_date + 2, 'checked_in', 'G6 Diner' from rooms where room_number = 'G03';
do $$
declare
  b uuid := (select id from bookings where contact_name = 'G6 Diner');
  o uuid;
begin
  o := pos_open_order((select id from pos_outlets where code = 'RST' and property_id = current_property()), 'G6');
  perform pos_add_line(o, '00000000-0000-0000-0000-0000000000e6', 1);
  perform pos_charge_to_room(o, b);
  update folio_entries set voided_at = now(), void_reason = 'G6 guest disputes the bill'
   where booking_id = b and reference = (select number from pos_orders where id = o) and voided_at is null;
  assert (select status from pos_orders where id = o) = 'open', 'the bill should be open again at the outlet';
  assert not exists (select 1 from pos_payments where order_id = o and kind = 'room_charge' and voided_at is null),
    'the room-charge payment should be voided with the folio lines';
end;
$$;

\echo 'G7. an event cannot be billed to a stay that has checked out'
insert into bookings (room_type_id, check_in, check_out, status, contact_name)
select id, current_date - 3, current_date - 1, 'checked_out', 'G7 Gone'
  from room_types where slug = 'premier-room' and property_id = current_property();
do $$
declare ev uuid; msg text := '';
begin
  insert into event_bookings (number, financial_year, seq, space_id, title, contact_name,
    event_date, start_time, end_time, setup_from, teardown_to, pax_expected, status, created_by)
  values ('EVT/G7/0001', '2026-27', 9941, (select id from event_spaces where code = 'HALL' and property_id = current_property()),
    'G7 lunch', 'G7', current_date + 120, '12:00', '15:00', '11:00', '15:30', 10, 'confirmed',
    '00000000-0000-0000-0000-000000000001')
  returning id into ev;
  insert into event_lines (event_id, kind, description, qty, unit_price) values (ev, 'other', 'Hall rental', 1, 2000);
  begin
    perform event_post_to_folio(ev, (select id from bookings where contact_name = 'G7 Gone'));
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'EVENT_BOOKING_NOT_RESIDENT%', 'billing a checked-out stay: expected EVENT_BOOKING_NOT_RESIDENT, got [' || msg || ']';
end;
$$;

\echo 'G8. an event charged to a folio cannot also get its own invoice'
do $$
declare ev uuid := (select id from event_bookings where number = 'EVT/G7/0001'); msg text := '';
begin
  perform event_post_to_folio(ev, (select id from bookings where contact_name = 'G6 Diner'));
  begin
    insert into invoices (number, series, financial_year, seq, event_id, bill_to_name, net_total, tax_total, grand_total)
    values ('G8/2026-27/0001', 'G8', '2026-27', 1, ev, 'G8', 2000, 0, 2000);
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'EVENT_ON_FOLIO%', 'invoicing an event already on a folio: expected EVENT_ON_FOLIO, got [' || msg || ']';
end;
$$;

\echo 'G9. foreign-currency cash is not counted as rupees in the drawer'
do $$
declare shift uuid := my_open_shift(); before numeric;
begin
  if shift is null then shift := cashier_open_shift(0); end if;
  before := cashier_shift_expected(shift);
  insert into folio_entries (booking_id, kind, description, amount, method, fx_currency, fx_rate, fx_amount)
  values ((select id from bookings where contact_name = 'G6 Diner'), 'payment', 'G9 paid in dollars', 8400, 'cash', 'USD', 84, 100);
  assert cashier_shift_expected(shift) = before,
    'USD cash should not change the rupee drawer, got ' || cashier_shift_expected(shift) || ' from ' || before;
end;
$$;

-- ── Stock ───────────────────────────────────────────────────────────────────
\echo 'G10. a bill settled, reopened and voided gives its stock back'
do $$
declare
  minibar uuid := (select id from pos_outlets where code = 'MIN' and property_id = current_property());
  cola uuid := '00000000-0000-0000-0000-0000000000f2';
  item uuid := (select id from inventory_items where pos_item_id = '00000000-0000-0000-0000-0000000000f2');
  loc uuid := (select id from inventory_locations where outlet_id = (select id from pos_outlets where code = 'MIN' and property_id = current_property()));
  o uuid; before numeric;
begin
  before := coalesce((select sum(qty) from inventory_movements where item_id = item and location_id = loc), 0);
  o := pos_open_order(minibar, 'G10');
  perform pos_add_line(o, cola, 2);
  perform pos_take_payment(o, 'cash', pos_order_balance(o));
  assert coalesce((select sum(qty) from inventory_movements where item_id = item and location_id = loc), 0) = before - 2,
    'fixture: settling should take two Colas';
  update pos_payments set voided_at = now(), void_reason = 'G10' where order_id = o;
  update pos_orders set status = 'open', closed_at = null where id = o;
  update pos_orders set status = 'void' where id = o;
  assert coalesce((select sum(qty) from inventory_movements where item_id = item and location_id = loc), 0) = before,
    'voiding the bill should put back what it took';
end;
$$;

-- ── Guests and loyalty ──────────────────────────────────────────────────────
\echo 'G11. cancelling an invoice or issuing a credit note takes its points back'
reset role;
update property_settings set loyalty_enabled = true;
insert into guests (full_name, email, loyalty_opt_in) values ('G11 Member', 'g11@example.com', true);
insert into bookings (guest_id, room_type_id, check_in, check_out, status, contact_name)
select (select id from guests where email = 'g11@example.com'), id, current_date - 2, current_date, 'checked_out', 'G11 Stay'
  from room_types where slug = 'premier-room' and property_id = (select id from properties where code = 'H1');
set role authenticated;
do $$
declare
  g uuid := (select id from guests where email = 'g11@example.com');
  b uuid := (select id from bookings where contact_name = 'G11 Stay');
  inv uuid; earned int;
begin
  insert into folio_entries (booking_id, kind, description, amount) values (b, 'extra', 'G11 stay', 10000);
  insert into invoices (number, series, financial_year, seq, booking_id, folio_id, bill_to_name, net_total, tax_total, grand_total)
  values ('G11/2026-27/0001', 'G11', '2026-27', 1, b, master_folio(b), 'G11', 10000, 0, 10000) returning id into inv;
  earned := loyalty_balance(g);
  assert earned > 0, 'fixture: the invoice should earn points';

  update invoices set status = 'cancelled', cancel_reason = 'G11 wrong name', cancelled_at = now() where id = inv;
  assert loyalty_balance(g) = 0, 'a cancelled invoice should take its points back, balance ' || loyalty_balance(g);

  insert into invoices (number, series, financial_year, seq, booking_id, folio_id, bill_to_name, net_total, tax_total, grand_total)
  values ('G11/2026-27/0002', 'G11', '2026-27', 2, b, master_folio(b), 'G11', 10000, 0, 10000) returning id into inv;
  assert loyalty_balance(g) = earned, 're-issuing should earn the points once, not twice';
  perform set_config('fix.g11_earned', earned::text, false);
end;
$$;
-- Credit notes are only written by credit_note_issue() (no insert policy), so as the owner here.
reset role;
insert into credit_notes (number, series, financial_year, seq, invoice_id, booking_id, folio_id, reason_code,
                          bill_to_name, net_total, tax_total, grand_total, property_id, tax_regime, lines)
select 'G11CN/2026-27/0001', 'G11CN', '2026-27', 1, i.id, i.booking_id, i.folio_id, 'discount', 'G11', 5000, 0, 5000, i.property_id, coalesce(i.tax_regime, 'gst'), '[]'::jsonb
  from invoices i where i.number = 'G11/2026-27/0002';
set role authenticated;
do $$
declare
  g uuid := (select id from guests where email = 'g11@example.com');
  earned int := current_setting('fix.g11_earned')::int;
begin
  assert loyalty_balance(g) = earned - floor(earned / 2.0),
    'a credit note for half the invoice should take back half its points, balance ' || loyalty_balance(g);
end;
$$;

\echo 'G12. a guest cannot be merged into an erased profile'
reset role;
insert into guests (full_name, email) values ('G12 Erased', 'g12-erased@example.com'), ('G12 Other', 'g12-other@example.com');
update guests set erased_at = now() where email = 'g12-erased@example.com';
set role authenticated;
do $$
declare msg text := '';
begin
  begin
    perform merge_guests((select id from guests where email = 'g12-erased@example.com'),
                         (select id from guests where email = 'g12-other@example.com'));
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'GUEST_ERASED%', 'merging into an erased guest: expected GUEST_ERASED, got [' || msg || ']';
end;
$$;

\echo 'G13. exchange rates are changed by head office only'
reset role;
update staff set all_properties = false where id = '00000000-0000-0000-0000-000000000007';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000007', false);
set role authenticated;
do $$
declare n int;
begin
  update currencies set rate_to_base = rate_to_base where code = 'USD';
  get diagnostics n = row_count;
  assert n = 0, 'a hotel manager should not change the group''s exchange rates';
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;

-- ── People ──────────────────────────────────────────────────────────────────
\echo 'G14. HR records are filed at the person''s own hotel'
-- Head office (admin, home H1) clocks in while looking at DL. Separate
-- statements, because clock-out must come after clock-in.
select set_active_property((select id from properties where code = 'DL')) is null as on_dl;
select clock_in() is not null as clocked_in;
do $$
begin
  assert (select property_id from attendance where staff_id = auth.uid() and clock_out is null)
       = (select property_id from staff where id = auth.uid()),
    'attendance should be filed at the home hotel, not the one being viewed';
end;
$$;
select clock_out() is not null as clocked_out;
select set_active_property((select id from properties where code = 'H1')) is null as back_on_h1;

\echo 'G15. a biometric punch is filed at the person''s hotel'
reset role;
update staff set employee_code = 'DLDESK1' where id = '00000000-0000-0000-0000-0000000000d1';
select set_config('request.jwt.claim.role', 'service_role', false);
select set_config('request.jwt.claim.sub', '', false);
do $$
begin
  perform attendance_device_event('DLDESK1', 'in');
  assert (select property_id from attendance where staff_id = '00000000-0000-0000-0000-0000000000d1' and clock_out is null)
       = (select id from properties where code = 'DL'),
    'a DL employee''s punch should be filed at DL';
  perform attendance_device_event('DLDESK1', 'out', now() + interval '1 minute');
end;
$$;
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;

\echo 'G16. the payroll export can read the roster'
do $$
begin
  assert exists (select 1 from pg_policies where tablename = 'staff_shifts' and policyname = 'staff_shifts_select'
                  and qual like '%hr.export%'), 'staff_shifts should be readable with hr.export';
end;
$$;

\echo 'G17. an administrator can move a staff member to another hotel'
do $$
begin
  perform staff_move_property('00000000-0000-0000-0000-000000000004', (select id from properties where code = 'DL'));
end;
$$;
reset role;
do $$
begin
  assert (select p.code from staff s join properties p on p.id = s.property_id
           where s.id = '00000000-0000-0000-0000-000000000004') = 'DL', 'the move should go through';
end;
$$;
update staff set property_id = (select id from properties where code = 'H1') where id = '00000000-0000-0000-0000-000000000004';

\echo 'G18. a scheduled job can work for one hotel at a time'
reset role;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', 'service_role', false);
select set_config('request.jwt.claims', json_build_object('role', 'service_role', 'property', (select id from properties where code = 'DL'))::text, false);
do $$
begin
  assert current_property() = (select id from properties where code = 'DL'),
    'a service request naming DL should work in DL';
  -- On Neon a nightly job runs as the owner with service_role in its claims,
  -- not as a service_role database role: functions that allow "or the
  -- service role" (forecast, reports) must still let it in.
  assert is_service_role(), 'a service-role request should count as the service role';
end;
$$;
select set_config('request.jwt.claims', '{"role":"service_role"}', false);
do $$
begin
  assert current_property() = (select id from properties where is_default),
    'a service request naming no hotel should fall back to the default hotel';
end;
$$;
select set_config('request.jwt.claims', '', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

\echo 'ALL 0041 ASSERTIONS PASSED'
