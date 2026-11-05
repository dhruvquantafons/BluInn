-- ============================================================================
-- Commercial, part 2: the manager's flash report
--
-- The one page a general manager reads every morning: yesterday, the month
-- so far and the financial year so far, each beside the same period last
-- year, with occupancy, ADR and RevPAR, revenue by department, and the day's
-- movements (arrivals, departures, no-shows, walk-ins, rooms off sale), the
-- week ahead on the books and what in-house guests owe.
--
--   flash_period(from, to)  the figures for one period, as jsonb
--   report_flash(date)      the whole report for one business date
--
-- Rooms sold, available and room revenue come from report_daily (0018,
-- 0031), so a day closed by night audit reports exactly what the audit froze
-- and complimentary rooms stay out of occupancy and ADR. Revenue by
-- department reads folio_entries.revenue_dept (0036) plus outlet bills paid at
-- the outlet and events billed on their own, less allowances and credit notes.
-- All figures are before tax.
--
-- Financial figures, so reports.financial only.
--
-- Run after 0036_gst_invoicing.sql.
-- ============================================================================

create or replace function flash_period(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid := current_property();
  v_daily    record;
  v_comp     int;
  v_house    int;
  v_revenue  jsonb;
  v_tax      numeric;
  v_credit   numeric;
begin
  if not (has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  select coalesce(sum(d.rooms_available), 0)::int as available,
         coalesce(sum(d.rooms_sold), 0)::int      as sold,
         coalesce(sum(d.room_revenue), 0)         as room_revenue,
         count(*) filter (where d.source = 'audit')::int as audited,
         count(*)::int                             as days
    into v_daily
    from report_daily(p_from, p_to) d;

  -- Complimentary and house-use room nights, which report_daily leaves out.
  select coalesce(sum(b.rooms_count) filter (where b.stay_type = 'complimentary'), 0)::int,
         coalesce(sum(b.rooms_count) filter (where b.stay_type = 'house_use'), 0)::int
    into v_comp, v_house
    from bookings b
    cross join lateral generate_series(greatest(b.check_in, p_from), least(b.check_out - 1, p_to), interval '1 day') n
   where b.property_id = v_property
     and b.status in ('checked_in', 'checked_out')
     and b.stay_type <> 'paid'
     and b.check_in <= p_to and b.check_out > p_from;

  with lines as (
    -- Charges on folios, on the night or day they belong to.
    select f.revenue_dept as dept, f.amount as net
      from folio_entries f
     where f.voided_at is null
       and f.property_id = v_property
       and f.kind in ('room', 'fee', 'penalty', 'extra')
       and coalesce(f.revenue_dept, 'other') <> 'paid_out'
       and coalesce(f.stay_date, local_day(f.created_at)) between p_from and p_to
    union all
    -- Allowances against a charge come off that charge's department.
    select f.revenue_dept, -(f.amount - f.tax_amount)
      from folio_entries f
     where f.voided_at is null
       and f.property_id = v_property
       and f.kind = 'adjustment' and f.applies_to is not null
       and local_day(f.created_at) between p_from and p_to
    union all
    -- Outlet bills settled at the outlet; a bill charged to a room is on the
    -- folio already (0032).
    select case when o.kind in ('restaurant', 'bar', 'room_service', 'mini_bar') then 'fnb'
                when o.kind = 'laundry' then 'laundry'
                when o.kind = 'spa' then 'spa'
                else 'other' end,
           po.net_total + po.service_net
      from pos_orders po
      join pos_outlets o on o.id = po.outlet_id
     where po.status = 'settled'
       and po.property_id = v_property
       and local_day(coalesce(po.closed_at, po.opened_at)) between p_from and p_to
       and not exists (
         select 1 from pos_payments pp
          where pp.order_id = po.id and pp.kind = 'room_charge' and pp.voided_at is null)
    union all
    -- Events that carry their own bill.
    select 'events', e.net_total
      from event_bookings e
     where e.status in ('confirmed', 'completed')
       and e.property_id = v_property
       and e.event_date between p_from and p_to
       and not exists (
         select 1 from event_payments p
          where p.event_id = e.id and p.kind = 'room_charge' and p.voided_at is null)
    union all
    -- Credit notes reduce the period they are issued in.
    select coalesce(l ->> 'dept', 'other'), -(l ->> 'net')::numeric
      from credit_notes c
      cross join lateral jsonb_array_elements(c.lines) l
     where c.property_id = v_property
       and local_day(c.issued_at) between p_from and p_to
  )
  select coalesce(jsonb_object_agg(dept, total), '{}'::jsonb) into v_revenue
    from (select coalesce(dept, 'other') as dept, round(sum(net), 2) as total
            from lines group by 1) x;

  select coalesce(sum(t.tax), 0) into v_tax from report_tax_summary(p_from, p_to) t;

  select coalesce(sum(c.grand_total), 0) into v_credit
    from credit_notes c
   where c.property_id = v_property and local_day(c.issued_at) between p_from and p_to;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'days', v_daily.days,
    'audited_days', v_daily.audited,
    'rooms_available', v_daily.available,
    'rooms_sold', v_daily.sold,
    'room_revenue', round(v_daily.room_revenue, 2),
    'comp_rooms', v_comp,
    'house_rooms', v_house,
    'revenue', v_revenue,
    'tax', round(v_tax, 2),
    'credit_notes', round(v_credit, 2)
  );
end;
$$;

create or replace function report_flash(p_date date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid := current_property();
  v_ly       date := (p_date - interval '1 year')::date;
  v_month    date := date_trunc('month', p_date)::date;
  v_ly_month date := date_trunc('month', v_ly)::date;
  v_fy       date;
  v_ly_fy    date;
  v_day      jsonb;
  v_ahead    jsonb;
  v_owed     numeric;
begin
  if not (has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  -- The Indian financial year starts on 1 April.
  v_fy := make_date(case when extract(month from p_date) >= 4 then extract(year from p_date)::int
                         else extract(year from p_date)::int - 1 end, 4, 1);
  v_ly_fy := (v_fy - interval '1 year')::date;

  select jsonb_build_object(
    'arrivals',       count(*) filter (where b.check_in = p_date and b.status in ('checked_in', 'checked_out')),
    'departures',     count(*) filter (where b.check_out = p_date and b.status = 'checked_out'),
    'walk_ins',       count(*) filter (where b.check_in = p_date and b.source = 'walk_in'
                                         and b.status in ('checked_in', 'checked_out')),
    'no_shows',       count(*) filter (where b.check_in = p_date and b.status = 'no_show'),
    'cancellations',  count(*) filter (where b.status = 'cancelled' and local_day(b.cancelled_at) = p_date),
    'in_house_rooms', coalesce(sum(b.rooms_count) filter (
                        where b.check_in <= p_date and b.check_out > p_date
                          and b.status in ('checked_in', 'checked_out')), 0),
    'in_house_guests', coalesce(sum(b.adults + b.children) filter (
                        where b.check_in <= p_date and b.check_out > p_date
                          and b.status in ('checked_in', 'checked_out')), 0)
  ) into v_day
    from bookings b
   where b.property_id = v_property
     and (b.check_in <= p_date + 1 and b.check_out >= p_date
          or local_day(b.cancelled_at) = p_date);

  v_day := v_day || jsonb_build_object('rooms_off_sale', (
    select count(distinct rb.room_id)
      from room_blocks rb
      join rooms r on r.id = rb.room_id
     where r.property_id = v_property
       and rb.start_date <= p_date
       and (rb.end_date is null or rb.end_date >= p_date)
       and (rb.released_at is null or local_day(rb.released_at) > p_date)));

  -- The week ahead as it stands on the books now.
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day,
           'rooms_sold', d.sold,
           'rooms_available', sellable_rooms()) order by d.day), '[]'::jsonb)
    into v_ahead
    from (
      select n::date as day,
             (select coalesce(sum(b.rooms_count), 0)
                from bookings b
               where b.property_id = v_property
                 and b.status in ('confirmed', 'checked_in')
                 and b.stay_type = 'paid'
                 and b.check_in <= n::date and b.check_out > n::date)::int as sold
        from generate_series(p_date + 1, p_date + 7, interval '1 day') n
    ) d;

  select coalesce(sum(folio_balance(b.id)), 0) into v_owed
    from bookings b
   where b.property_id = v_property and b.status = 'checked_in';

  return jsonb_build_object(
    'date', p_date,
    'periods', jsonb_build_object(
      'day',    flash_period(p_date, p_date),
      'mtd',    flash_period(v_month, p_date),
      'ytd',    flash_period(v_fy, p_date),
      'ly_day', flash_period(v_ly, v_ly),
      'ly_mtd', flash_period(v_ly_month, v_ly),
      'ly_ytd', flash_period(v_ly_fy, v_ly)
    ),
    'today', v_day,
    'ahead', v_ahead,
    'in_house_balance', round(v_owed, 2)
  );
end;
$$;

revoke execute on function flash_period(date, date) from public, anon;
revoke execute on function report_flash(date) from public, anon;
grant execute on function flash_period(date, date) to authenticated, service_role;
grant execute on function report_flash(date) to authenticated, service_role;
