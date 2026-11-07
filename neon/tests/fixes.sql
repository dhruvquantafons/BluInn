-- ============================================================================
-- Assertions for 0039_interconnection_fixes.sql. Runs after behaviour.sql (it
-- reuses that file's fixtures: property H1, the premier room type, the COLA
-- and SHMP stock items, administrator 00000000-...-0001).
--
-- Unlike behaviour.sql, every check here is an ASSERT: the first one that
-- fails stops the run with ON_ERROR_STOP, so a clean exit means all passed.
-- ============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1

reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
set role authenticated;
select set_active_property((select id from properties where code = 'H1')) is null as h1;

-- Fixture stays, far enough ahead that nothing else in the suite clashes.
insert into bookings (room_type_id, check_in, check_out, status, contact_name)
select id, current_date + x.d, current_date + x.d + 1, 'confirmed', x.name
  from room_types, (values ('Fix Invoiced', 200), ('Fix Closed Day', 202), ('Fix Refund', 204)) as x (name, d)
 where slug = 'premier-room' and property_id = current_property();

-- ── 1. Nothing new lands on a folio once it has been invoiced ───────────────
\echo '1. folio invoiced: charges move to a new folio, voids and allowances refused'
do $$
declare
  b uuid := (select id from bookings where contact_name = 'Fix Invoiced');
  c1 uuid; master uuid; late record; later record; msg text := '';
begin
  insert into folio_entries (booking_id, kind, description, amount)
  values (b, 'extra', 'Dinner', 100) returning id, folio_id into c1, master;
  insert into invoices (number, series, financial_year, seq, booking_id, folio_id, bill_to_name, net_total, tax_total, grand_total)
  values ('FIX/2026-27/0001', 'FIX', '2026-27', 1, b, master, 'Fix', 100, 0, 100);

  insert into folio_entries (booking_id, kind, description, amount)
  values (b, 'extra', 'Late dinner', 50) returning id, folio_id into late;
  assert late.folio_id <> master, 'a charge after the invoice landed on the invoiced folio';
  assert (select label from folios where id = late.folio_id) = 'After invoice',
    'the charge after the invoice should go to an "After invoice" folio';

  insert into folio_entries (booking_id, folio_id, kind, description, amount)
  values (b, master, 'fee', 'Explicitly aimed at the invoiced folio', 10) returning id, folio_id into later;
  assert later.folio_id = late.folio_id, 'later charges should share the one "After invoice" folio';

  begin
    update folio_entries set voided_at = now(), void_reason = 'test' where id = c1;
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'FOLIO_INVOICED%', 'voiding an invoiced line: expected FOLIO_INVOICED, got [' || msg || ']';

  msg := '';
  begin
    insert into folio_entries (booking_id, kind, description, amount, applies_to)
    values (b, 'adjustment', 'Goodwill', 20, c1);
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'FOLIO_INVOICED%', 'an allowance on an invoiced line: expected FOLIO_INVOICED, got [' || msg || ']';

  -- Money in is still taken against the invoice.
  insert into folio_entries (booking_id, kind, description, amount, method)
  values (b, 'payment', 'Settles the invoice', 100, 'card') returning id, folio_id into later;
  assert later.folio_id = master, 'a payment should still settle the invoiced folio';

  -- Once the invoice is cancelled the folio is open again.
  update invoices set status = 'cancelled', cancel_reason = 'test', cancelled_at = now()
   where number = 'FIX/2026-27/0001';
  update folio_entries set voided_at = now(), void_reason = 'test' where id = c1;
end;
$$;

-- ── 2. A closed day stays closed ─────────────────────────────────────────────
\echo '2. closed day: late lines move to the open business date; closed-day bills cannot reopen'
reset role;
insert into night_audits (property_id, business_date, status, completed_at, report)
select id, current_date - 30, 'completed', now(), '{}' from properties where code = 'H1';
set role authenticated;
do $$
declare
  b uuid := (select id from bookings where contact_name = 'Fix Closed Day');
  open_day date := (select business_date from properties where id = current_property());
  e record; msg text := '';
begin
  insert into folio_entries (booking_id, kind, description, amount, stay_date)
  values (b, 'extra', 'Back-dated minibar', 40, current_date - 30) returning stay_date into e;
  assert e.stay_date = open_day,
    'a charge dated into a closed day should be posted to the open business date, got ' || e.stay_date;

  -- A room night keeps its own night: the unique night index depends on it.
  insert into folio_entries (booking_id, kind, description, amount, stay_date)
  values (b, 'room', 'Missed night', 10, current_date - 30) returning stay_date into e;
  assert e.stay_date = current_date - 30, 'a room night must keep its own date';
end;
$$;

reset role;
insert into pos_orders (number, outlet_id, status, net_total, grand_total, opened_at, closed_at, property_id)
select 'FIX-POS-1', o.id, 'settled', 100, 100, now() - interval '31 days', now() - interval '30 days', o.property_id
  from pos_outlets o where o.property_id = (select id from properties where code = 'H1') limit 1;
do $$
declare msg text := '';
begin
  begin
    update pos_orders set status = 'open' where number = 'FIX-POS-1';
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'POS_DAY_CLOSED%', 'reopening a bill from a closed day: expected POS_DAY_CLOSED, got [' || msg || ']';
end;
$$;
set role authenticated;

-- ── 3. Merging duplicate guests ──────────────────────────────────────────────
\echo '3. merge guests: works for a guest with bookings, keeps loyalty'
insert into guests (full_name, email) values ('Merge Keep', 'keep@example.com'), ('Merge Drop', 'drop@example.com');
insert into bookings (guest_id, room_type_id, check_in, check_out, status, contact_name)
select (select id from guests where full_name = 'Merge Drop'), id, current_date + 210, current_date + 211, 'confirmed', 'Merge Drop'
  from room_types where slug = 'premier-room' and property_id = current_property();
reset role;
insert into loyalty_transactions (guest_id, kind, points, remaining, description, property_id)
select id, 'adjust', 250, 250, 'Fixture points', (select id from properties where code = 'H1')
  from guests where full_name = 'Merge Drop';
update guests set loyalty_member_no = 'M-DROP', loyalty_opt_in = true where full_name = 'Merge Drop';
set role authenticated;
do $$
declare
  k uuid := (select id from guests where full_name = 'Merge Keep');
  d uuid := (select id from guests where full_name = 'Merge Drop');
begin
  perform merge_guests(k, d);
  assert not exists (select 1 from guests where id = d), 'the dropped guest should be gone';
  assert (select guest_id from bookings where contact_name = 'Merge Drop') = k, 'the booking should move to the kept guest';
  assert not exists (select 1 from booking_guests where guest_id = d), 'no booking_guests row may point at the dropped guest';
  assert exists (select 1 from booking_guests bg join bookings b on b.id = bg.booking_id
                  where b.contact_name = 'Merge Drop' and bg.guest_id = k and bg.is_primary),
    'the kept guest should be the primary guest on the moved booking';
  assert (select coalesce(sum(points), 0) from loyalty_transactions where guest_id = k) = 250,
    'loyalty points should move to the kept guest';
  assert (select loyalty_member_no from guests where id = k) = 'M-DROP', 'the membership number should carry over';
end;
$$;

-- ── 5. Refunds never exceed what was paid ────────────────────────────────────
\echo '5. refunds: capped at what was paid, on folios and on events'
do $$
declare
  b uuid := (select id from bookings where contact_name = 'Fix Refund');
  msg text := '';
begin
  insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'payment', 'Deposit', 1000, 'card');

  begin
    insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'refund', 'Too much', 1500, 'card');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'REFUND_EXCEEDS_PAID%', 'refunding more than paid: expected REFUND_EXCEEDS_PAID, got [' || msg || ']';

  insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'refund', 'Part', 600, 'card');
  assert refundable_amount(b) = 400, 'refundable_amount should be 400 after a 600 refund of 1000, got ' || refundable_amount(b);

  msg := '';
  begin
    insert into folio_entries (booking_id, kind, description, amount, method) values (b, 'refund', 'Rest and more', 500, 'card');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'REFUND_EXCEEDS_PAID%', 'second refund past the balance: expected REFUND_EXCEEDS_PAID, got [' || msg || ']';
end;
$$;

do $$
declare
  b uuid := (select id from bookings where contact_name = 'Fix Refund');
  msg text := '';
begin
  -- 1000 paid, 600 refunded: a request reserves its amount until paid or refused.
  insert into refund_requests (booking_id, amount, reason, method, requested_by)
  values (b, 300, 'Partial', 'card', '00000000-0000-0000-0000-000000000001');
  begin
    insert into refund_requests (booking_id, amount, reason, method, requested_by)
    values (b, 200, 'More than is left', 'card', '00000000-0000-0000-0000-000000000001');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'REFUND_EXCEEDS_PAID%', 'a request past what is left: expected REFUND_EXCEEDS_PAID, got [' || msg || ']';
end;
$$;

insert into event_bookings (number, financial_year, seq, space_id, title, contact_name,
  event_date, start_time, end_time, setup_from, teardown_to, pax_expected, status, created_by)
values ('EVT/FIX/0001', '2026-27', 9901, (select id from event_spaces where code = 'HALL' and property_id = current_property()),
  'Refund test', 'R', current_date + 90, '09:00', '12:00', '08:00', '12:30', 20, 'confirmed',
  '00000000-0000-0000-0000-000000000001');
insert into event_lines (event_id, kind, description, qty, unit_price)
select id, 'other', 'Hall rental', 1, 5000 from event_bookings where number = 'EVT/FIX/0001';
do $$
declare
  ev uuid := (select id from event_bookings where number = 'EVT/FIX/0001');
  msg text := '';
begin
  perform event_take_payment(ev, 'advance', 'card', 1000);
  begin
    perform event_take_payment(ev, 'refund', 'card', 1500);
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'EVENT_REFUND_EXCEEDS_PAID%', 'event refund past what was paid: expected EVENT_REFUND_EXCEEDS_PAID, got [' || msg || ']';
  perform event_take_payment(ev, 'refund', 'card', 1000);
end;
$$;

-- ── 7. Stock is consumed once, and manual moves cannot go below zero ─────────
\echo '7. inventory: one deduction per task and per bill; no negative manual moves'
reset role;
insert into housekeeping_tasks (room_id, task_date, kind, status, checklist, property_id)
select r.id, current_date + 1, 'touch_up', 'in_progress',
       jsonb_build_array(jsonb_build_object('item_id', ii.hk_checklist_item_id, 'done', true, 'qty', 2)),
       r.property_id
  from rooms r, inventory_items ii
 where r.room_number = '102' and r.property_id = (select id from properties where code = 'H1')
   and ii.sku = 'SHMP' and ii.property_id = r.property_id
 limit 1;
do $$
declare
  t uuid := (select id from housekeeping_tasks where kind = 'touch_up' and task_date = current_date + 1
              and checklist::text like '%"qty": 2%' order by created_at desc limit 1);
  ref text := 'HK ' || left(t::text, 8);
begin
  update housekeeping_tasks set status = 'cleaned' where id = t;
  assert (select sum(qty) from inventory_movements where reference = ref) = -2, 'first clean should consume 2';
  -- Failed inspection, cleaned again.
  update housekeeping_tasks set status = 'pending' where id = t;
  update housekeeping_tasks set status = 'in_progress' where id = t;
  update housekeeping_tasks set status = 'cleaned' where id = t;
  assert (select sum(qty) from inventory_movements where reference = ref) = -2,
    're-cleaning after a failed inspection consumed the amenities again: ' ||
    (select sum(qty) from inventory_movements where reference = ref);
end;
$$;

insert into pos_orders (number, outlet_id, status, opened_at, property_id)
select 'FIX-POS-2', o.id, 'open', now(), o.property_id
  from pos_outlets o where o.code = 'MIN' and o.property_id = (select id from properties where code = 'H1');
insert into pos_order_lines (order_id, item_id, name, qty, unit_price, property_id)
select id, '00000000-0000-0000-0000-0000000000f2', 'Cola', 3, 80, property_id from pos_orders where number = 'FIX-POS-2';
do $$
begin
  update pos_orders set status = 'settled', closed_at = now() where number = 'FIX-POS-2';
  assert (select sum(qty) from inventory_movements where reference = 'FIX-POS-2') = -3, 'settling should consume 3';
  update pos_orders set status = 'open', closed_at = null where number = 'FIX-POS-2';
  update pos_orders set status = 'settled', closed_at = now() where number = 'FIX-POS-2';
  assert (select sum(qty) from inventory_movements where reference = 'FIX-POS-2') = -3,
    're-settling a reopened bill consumed the stock again: ' ||
    (select sum(qty) from inventory_movements where reference = 'FIX-POS-2');
end;
$$;

set role authenticated;
do $$
declare msg text := '';
begin
  begin
    perform inventory_move((select id from inventory_items where sku = 'COLA'), 'wastage', 100000,
            (select id from inventory_locations where name = 'Main store'), null, 'Broken');
  exception when others then msg := sqlerrm;
  end;
  assert msg like 'INVENTORY_SHORT%', 'taking more than is on hand: expected INVENTORY_SHORT, got [' || msg || ']';
end;
$$;

-- ── 8. A room back from maintenance gets a cleaning task ─────────────────────
\echo '8. room back in service: dirty, with a touch-up task waiting'
reset role;
do $$
declare
  r uuid := (select id from rooms where room_number = '103' and property_id = (select id from properties where code = 'H1'));
begin
  update rooms set status = 'out_of_order', housekeeping_status = 'inspected' where id = r;
  delete from room_blocks where room_id = r;
  update rooms set status = 'available' where id = r;
  assert (select housekeeping_status from rooms where id = r) = 'dirty',
    'a room returning from out of order should be dirty, not ' || (select housekeeping_status from rooms where id = r);
  assert exists (select 1 from housekeeping_tasks where room_id = r and status in ('pending', 'in_progress')),
    'a room returning from out of order should have an open housekeeping task';
end;
$$;

\echo 'ALL FIX ASSERTIONS PASSED'
