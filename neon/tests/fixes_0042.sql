-- ============================================================================
-- Assertions for 0042_event_rooms_and_till_stock.sql:
--   events hold guest rooms (through a linked group), the rooms follow the
--   event, unsold rooms are released at a cut-off, an organiser can pay for
--   the rooms on the event's bill; and an outlet till cannot sell more of an
--   item than its stock (minibar postings from housekeeping excepted).
-- Runs after fixes_0041.sql; reuses behaviour.sql's fixtures (H1, the premier
-- room type, the HALL space, the MIN outlet and its stock-linked Cola).
-- Every check is an ASSERT, so a clean exit means all passed.
-- ============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
select set_config('request.jwt.claims', '', false);
set role authenticated;
select set_active_property((select id from properties where code = 'H1')) is null as h1;

insert into event_bookings (number, financial_year, seq, space_id, title, contact_name,
  event_date, start_time, end_time, setup_from, teardown_to, pax_expected, status, created_by)
values
  ('EVT/H/0001', '2026-27', 9951, (select id from event_spaces where code = 'HALL' and property_id = current_property()),
   'Mehta wedding', 'Asha Mehta', current_date + 150, '18:00', '23:00', '16:00', '23:30', 100, 'quoted',
   '00000000-0000-0000-0000-000000000001'),
  ('EVT/H/0002', '2026-27', 9952, (select id from event_spaces where code = 'HALL' and property_id = current_property()),
   'Sales conference', 'Zenith', current_date + 152, '09:00', '17:00', '08:00', '17:30', 40, 'confirmed',
   '00000000-0000-0000-0000-000000000001');

-- ── Holding rooms ───────────────────────────────────────────────────────────
\echo 'H1. an event holds a block of rooms through a linked group'
do $$
declare
  ev uuid := (select id from event_bookings where number = 'EVT/H/0001');
  premier uuid := (select id from room_types where slug = 'premier-room' and property_id = current_property());
  g uuid;
begin
  g := event_hold_rooms(ev,
    jsonb_build_object('check_in', current_date + 150, 'check_out', current_date + 151,
                       'release_on', current_date + 136, 'room_billing', 'guest'),
    (select jsonb_agg(jsonb_build_object('room_type_id', premier, 'quoted_rate', 5000, 'total_amount', 5000,
                                         'rate_breakdown', jsonb_build_array(jsonb_build_object('date', current_date + 150, 'rate', 5000)),
                                         'adults', 2, 'contact_name', 'Mehta wedding — room ' || n))
       from generate_series(1, 3) n));
  assert (select event_id from booking_groups where id = g) = ev, 'the group should point at the event';
  assert (select count(*) from bookings where group_id = g and status = 'tentative' and hold_until is null) = 3,
    'a quoted event holds tentative rooms that do not expire by the hour';
end;
$$;

\echo 'H2. confirming the event confirms its rooms'
update event_bookings set status = 'confirmed', confirmed_at = now() where number = 'EVT/H/0001';
do $$
begin
  assert (select count(*) from bookings b join booking_groups g on g.id = b.group_id
           where g.event_id = (select id from event_bookings where number = 'EVT/H/0001') and b.status = 'confirmed') = 3,
    'the rooms should be confirmed with the event';
end;
$$;

\echo 'H3. releasing at the cut-off cancels only the rooms nobody has taken'
do $$
declare
  ev uuid := (select id from event_bookings where number = 'EVT/H/0001');
  released int;
begin
  update bookings set contact_name = 'Ravi Mehta'
   where id = (select b.id from bookings b join booking_groups g on g.id = b.group_id
                where g.event_id = ev order by b.contact_name limit 1);
  released := event_release_unsold_rooms(ev);
  assert released = 2, 'two unnamed rooms should be released, got ' || released;
  assert (select count(*) from bookings b join booking_groups g on g.id = b.group_id
           where g.event_id = ev and b.status = 'confirmed') = 1, 'the named room should stay';
end;
$$;

\echo 'H4. cancelling the event releases the rest of its rooms'
do $$
declare ev uuid := (select id from event_bookings where number = 'EVT/H/0001');
begin
  perform event_cancel(ev, 'Wedding moved to another venue');
  assert not exists (select 1 from bookings b join booking_groups g on g.id = b.group_id
                      where g.event_id = ev and b.status in ('tentative', 'confirmed')),
    'no room should stay held for a cancelled event';
end;
$$;

-- ── The organiser pays for the rooms ────────────────────────────────────────
\echo 'H5. an organiser-paid room''s nights go on the event''s bill, not the guest''s'
do $$
declare
  ev uuid := (select id from event_bookings where number = 'EVT/H/0002');
  premier uuid := (select id from room_types where slug = 'premier-room' and property_id = current_property());
  g uuid; b uuid; f uuid; before numeric;
begin
  g := event_hold_rooms(ev,
    jsonb_build_object('check_in', current_date + 152, 'check_out', current_date + 153,
                       'release_on', current_date + 138, 'room_billing', 'organiser'),
    jsonb_build_array(jsonb_build_object('room_type_id', premier, 'quoted_rate', 4000, 'total_amount', 4000,
      'rate_breakdown', jsonb_build_array(jsonb_build_object('date', current_date + 152, 'rate', 4000)),
      'adults', 1, 'contact_name', 'Delegate One')));
  b := (select id from bookings where group_id = g);
  assert (select status from bookings where id = b) = 'confirmed', 'a confirmed event holds confirmed rooms';

  before := event_balance(ev);
  f := event_room_folio(b);
  assert (select event_id from folios where id = f) = ev, 'the organiser folio should belong to the event';
  assert f = event_room_folio(b), 'one organiser folio per stay';

  insert into folio_entries (booking_id, folio_id, kind, description, amount, tax_amount, tax_rate, stay_date)
  values (b, f, 'room', 'Night of the conference', 4000, 200, 5, current_date + 152);
  assert event_balance(ev) = before + 4200, 'the event balance should include the organiser-paid night';
  assert event_rooms_total(ev) = 4200, 'the event''s room total should be the night with its tax';
end;
$$;

\echo 'H6. the event''s invoice covers the organiser-paid folio'
do $$
declare
  ev uuid := (select id from event_bookings where number = 'EVT/H/0002');
  f uuid := (select id from folios where event_id = (select id from event_bookings where number = 'EVT/H/0002'));
begin
  insert into invoices (number, series, financial_year, seq, event_id, bill_to_name, net_total, tax_total, grand_total)
  values ('H6/2026-27/0001', 'H6', '2026-27', 1, ev, 'Zenith', 4000, 200, 4200);
  assert folio_is_invoiced(f), 'the organiser folio counts as invoiced once the event is';
end;
$$;

-- ── Tills cannot sell more than the stock ───────────────────────────────────
\echo 'H7. a till refuses to sell more Cola than the minibar holds, counting open bills'
do $$
declare
  minibar uuid := (select id from pos_outlets where code = 'MIN' and property_id = current_property());
  cola uuid := '00000000-0000-0000-0000-0000000000f2';
  item uuid := (select id from inventory_items where pos_item_id = '00000000-0000-0000-0000-0000000000f2');
  loc uuid := (select id from inventory_locations where outlet_id = (select id from pos_outlets where code = 'MIN' and property_id = current_property()));
  on_hand numeric; o1 uuid; o2 uuid; msg text := '';
begin
  -- Count the shelf at exactly 3.
  perform inventory_move(item, 'adjust', 3, null, loc, 'H7 fixture');
  on_hand := coalesce((select sum(qty) from inventory_movements where item_id = item and location_id = loc), 0);
  assert on_hand = 3, 'fixture: the minibar should hold 3 Colas, has ' || on_hand;
  assert (select available from pos_item_stock(minibar) where pos_item_id = cola) = 3, 'the till should see 3 left';

  o1 := pos_open_order(minibar, 'H7a');
  begin
    perform pos_add_line(o1, cola, 4);
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'INVENTORY_OUT%', 'four from a shelf of three: expected INVENTORY_OUT, got [' || msg || ']';

  perform pos_add_line(o1, cola, 2);
  o2 := pos_open_order(minibar, 'H7b');
  perform pos_add_line(o2, cola, 1);
  msg := '';
  begin
    perform pos_add_line(o2, cola, 1);
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'INVENTORY_OUT%', 'the three are on open bills: expected INVENTORY_OUT, got [' || msg || ']';
  assert (select available from pos_item_stock(minibar) where pos_item_id = cola) = 0, 'the till should see it sold out';
  perform pos_void_order(o1, 'H7');
  perform pos_void_order(o2, 'H7');
end;
$$;

\echo 'H8. a minibar posting from housekeeping is never refused for stock'
do $$
declare
  minibar uuid := (select id from pos_outlets where code = 'MIN' and property_id = current_property());
  cola uuid := '00000000-0000-0000-0000-0000000000f2';
  room uuid := (select room_id from bookings where contact_name = 'G6 Diner');
begin
  perform hk_post_consumption(room, 'mini_bar', jsonb_build_array(jsonb_build_object('item_id', cola, 'qty', 5)));
  assert (select available from pos_item_stock(minibar) where pos_item_id = cola) < 0,
    'the guest is charged even though the shelf ran out; the stock goes short';
end;
$$;

\echo 'ALL 0042 ASSERTIONS PASSED'
