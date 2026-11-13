-- ============================================================================
-- Assertions for 0044_numbers.sql: section 6 of
-- docs/interconnection-audit-2026-11-13.md (inconsistent numbers). Runs after
-- fixes_0043.sql and reuses its fixtures (H1, RST and its bottled water ...00e6,
-- administrator ...01, the checked-in "V7 Diner").
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

-- Net revenue (before tax) for a range, three ways: the daily report, the
-- flash report's departments and the tax summary.
create or replace function pg_temp.daily_net(p_from date, p_to date) returns numeric language sql as $$
  select coalesce(sum(total_revenue - tax_total), 0) from report_daily(p_from, p_to);
$$;
create or replace function pg_temp.flash_net(p_from date, p_to date) returns numeric language sql as $$
  select coalesce(sum(value::numeric), 0) from jsonb_each_text(flash_period(p_from, p_to) -> 'revenue');
$$;
create or replace function pg_temp.tax_net(p_from date, p_to date) returns numeric language sql as $$
  select coalesce(sum(net), 0) from report_tax_summary(p_from, p_to);
$$;

\echo 'N1. a fee dated to another night is counted on that night in every column of the daily report'
insert into folio_entries (booking_id, kind, description, amount, stay_date)
select id, 'fee', 'N1 early check-in', 400, current_date + 2 from bookings where contact_name = 'V7 Diner';
do $$
declare r record;
begin
  for r in select * from report_daily(current_date - 40, current_date + 5) loop
    assert abs((r.total_revenue - r.tax_total) - (r.room_revenue + r.other_revenue)) < 0.01,
      format('report_daily %s: revenue %s ≠ room %s + other %s', r.day, r.total_revenue - r.tax_total,
             r.room_revenue, r.other_revenue);
  end loop;
end;
$$;

\echo 'N2. the daily report, the flash report and the tax summary agree on net revenue'
do $$
declare d date;
begin
  for d in select generate_series(current_date - 3, current_date + 3, interval '1 day')::date loop
    assert abs(pg_temp.daily_net(d, d) - pg_temp.flash_net(d, d)) < 0.01,
      format('%s: daily report %s, flash %s', d, pg_temp.daily_net(d, d), pg_temp.flash_net(d, d));
    -- The tax summary is by SAC from the lines; a closed day's frozen figures
    -- have no SAC, so it is compared on days not frozen by night audit.
    if (select source from report_daily(d, d)) = 'live' then
      assert abs(pg_temp.flash_net(d, d) - pg_temp.tax_net(d, d)) < 0.01,
        format('%s: flash %s, tax summary %s', d, pg_temp.flash_net(d, d), pg_temp.tax_net(d, d));
    end if;
  end loop;
  assert abs(pg_temp.daily_net(current_date - 40, current_date + 5) - pg_temp.flash_net(current_date - 40, current_date + 5)) < 0.01,
    'over 45 days the daily report and the flash report disagree';
end;
$$;

\echo 'N3. a paid-out and a room-charged tip are not revenue anywhere; an outlet bill paid at the outlet is'
do $$
declare
  b    uuid := (select id from bookings where contact_name = 'V7 Diner');
  rst  uuid := (select id from pos_outlets where code = 'RST' and property_id = current_property());
  d0 numeric; f0 numeric; t0 numeric;
  o1 uuid; o2 uuid; expected numeric;
begin
  d0 := pg_temp.daily_net(current_date, current_date);
  f0 := pg_temp.flash_net(current_date, current_date);
  t0 := pg_temp.tax_net(current_date, current_date);

  -- Cash paid out for the guest's taxi.
  insert into folio_entries (booking_id, kind, description, amount, stay_date)
  values (b, 'extra', 'Paid out: N3 taxi', 300, current_date);
  -- A dinner charged to the room with a tip.
  o1 := pos_open_order(rst, 'N3a');
  perform pos_add_line(o1, '00000000-0000-0000-0000-0000000000e6', 1);
  update pos_orders set tip_amount = 50 where id = o1;
  perform pos_charge_to_room(o1, b);
  -- A bill paid at the outlet.
  o2 := pos_open_order(rst, 'N3b');
  perform pos_add_line(o2, '00000000-0000-0000-0000-0000000000e6', 1);
  perform pos_take_payment(o2, 'cash', pos_order_balance(o2));

  select sum(net_total + service_net) into expected from pos_orders where id in (o1, o2);
  assert abs(pg_temp.daily_net(current_date, current_date) - d0 - expected) < 0.01,
    format('daily report moved by %s, expected %s (the two bills before tax, no tip, no paid-out)',
           pg_temp.daily_net(current_date, current_date) - d0, expected);
  assert abs(pg_temp.flash_net(current_date, current_date) - f0 - expected) < 0.01,
    format('flash moved by %s, expected %s', pg_temp.flash_net(current_date, current_date) - f0, expected);
  assert abs(pg_temp.tax_net(current_date, current_date) - t0 - expected) < 0.01,
    format('tax summary moved by %s, expected %s', pg_temp.tax_net(current_date, current_date) - t0, expected);
end;
$$;

\echo 'N4. a room-charged tip is classed as a tip and, like a paid-out, is not a supply'
do $$
begin
  assert (select revenue_dept from folio_entries where description like '% — tip' and reference =
           (select number from pos_orders where table_no = 'N3a')) = 'tip', 'the tip line should be classed tip';
  assert not (select is_supply(revenue_dept) from folio_entries where description like '% — tip' and reference =
           (select number from pos_orders where table_no = 'N3a')), 'a tip is not a supply';
  assert not (select is_supply(revenue_dept) from folio_entries where description = 'Paid out: N3 taxi'), 'a paid-out is not a supply';
  assert (select is_supply(revenue_dept) from folio_entries where description = 'N1 early check-in'), 'a fee is a supply';
end;
$$;

\echo 'N5. only out-of-order rooms leave the rooms available'
reset role;
insert into rooms (room_number, room_type_id, floor, status, housekeeping_status, property_id)
select r, rt.id, 9, 'available', 'inspected', rt.property_id
  from room_types rt join properties p on p.id = rt.property_id and p.code = 'H1',
       (values ('N51'), ('N52')) v(r)
 where rt.slug = 'premier-room';
insert into room_blocks (room_id, kind, start_date, end_date, reason)
select id, 'out_of_order', current_date + 30, current_date + 31, 'N5 new bathroom' from rooms where room_number = 'N51';
insert into room_blocks (room_id, kind, start_date, end_date, reason)
select id, 'out_of_service', current_date + 30, current_date + 31, 'N5 a lamp' from rooms where room_number = 'N52';
set role authenticated;
do $$
declare d date := current_date + 30; ooo int;
begin
  select count(distinct rb.room_id) into ooo
    from room_blocks rb join rooms r on r.id = rb.room_id
   where r.property_id = current_property() and rb.kind = 'out_of_order'
     and rb.start_date <= d and coalesce(rb.end_date, d) >= d
     and (rb.released_at is null or local_day(rb.released_at) > d);
  assert ooo >= 1, 'fixture: N51 should be out of order';
  assert sellable_rooms(d) = (select count(*) from rooms where property_id = current_property()) - ooo,
    format('%s rooms available; expected every room less the %s out of order (N52, out of service, stays in)',
           sellable_rooms(d), ooo);
  assert (select rooms_available from report_daily(d, d)) = sellable_rooms(d),
    'the daily report should use the night''s own blocks';
end;
$$;

\echo 'N6. the invoice year totals net credit notes and are not capped'
do $$
declare t record; fy text := financial_year_of(current_date);
begin
  select * into t from invoice_year_totals(fy);
  assert t.billed = (select coalesce(sum(grand_total), 0) from invoices
                      where financial_year = fy and status = 'issued' and property_id = current_property())
                  - (select coalesce(sum(c.grand_total), 0) from credit_notes c
                      where c.financial_year = fy and c.property_id = current_property()),
    format('billed %s does not net credit notes', t.billed);
end;
$$;

\echo 'N7. an HR viewer sees everyone''s tasks done, whatever their own access to housekeeping'
reset role;
insert into roles (key, name, description, is_system, is_superuser, requires_2fa, sort_order)
values ('n7_hr_viewer', 'N7 HR viewer', 'Test', false, false, false, 99) on conflict (key) do nothing;
insert into role_permissions (role_key, permission) values ('n7_hr_viewer', 'hr.view') on conflict do nothing;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e1', 'n7-hr@x.test') on conflict do nothing;
insert into staff (id, email, full_name, role, property_id)
values ('00000000-0000-0000-0000-0000000000e1', 'n7-hr@x.test', 'N7 HR', 'n7_hr_viewer', (select id from properties where code = 'H1'))
on conflict (id) do nothing;
insert into housekeeping_tasks (room_id, task_date, kind, status, completed_by, completed_at, property_id)
select r.id, current_date, 'stayover', 'inspected', '00000000-0000-0000-0000-000000000001', now(), r.property_id
  from rooms r where r.room_number = 'N51';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e1', false);
set role authenticated;
select set_active_property((select id from properties where code = 'H1')) is null as h1;
do $$
begin
  assert coalesce((select hk_done from staff_task_counts(now() - interval '30 days') where staff_id = '00000000-0000-0000-0000-000000000001'), 0) >= 1,
    'an hr.view user should see the administrator''s finished cleaning task';
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;


\echo 'N8. someone who can only bill events can read them'
reset role;
insert into roles (key, name, description, is_system, is_superuser, requires_2fa, sort_order)
values ('n8_events_bill', 'N8 events billing', 'Test', false, false, false, 99) on conflict (key) do nothing;
insert into role_permissions (role_key, permission) values ('n8_events_bill', 'events.bill') on conflict do nothing;
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000e2', 'n8-bill@x.test') on conflict do nothing;
insert into staff (id, email, full_name, role, property_id)
values ('00000000-0000-0000-0000-0000000000e2', 'n8-bill@x.test', 'N8 Bill', 'n8_events_bill', (select id from properties where code = 'H1'))
on conflict (id) do nothing;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e2', false);
set role authenticated;
select set_active_property((select id from properties where code = 'H1')) is null as h1;
do $$
declare seen int; total int;
begin
  seen := (select count(*) from event_bookings);
  reset role;
  total := (select count(*) from event_bookings where property_id = (select id from properties where code = 'H1'));
  set role authenticated;
  assert total > 0, 'fixture: H1 should have events';
  assert seen = total, format('events.bill alone sees %s of %s events', seen, total);
end;
$$;
reset role;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);
set role authenticated;

\echo 'ALL 0044 ASSERTIONS PASSED'
