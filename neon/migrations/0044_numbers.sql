-- ============================================================================
-- Section 6 of docs/interconnection-audit-2026-11-12.md: one number per
-- metric. Decisions of 13 November 2026:
--
--   * Revenue is the flash report's definition everywhere: before tax; outlet
--     bills paid at the outlet and events billed on their own count;
--     allowances and credit notes come off; paid-outs and tips are not revenue.
--   * Paid-outs and tips charged to a room stay on the guest's bill but are not
--     supplies: no taxable value, no GST register, no revenue, no points.
--   * Occupancy (USALI): out-of-order rooms leave the rooms available,
--     out-of-service rooms stay in, counted from the night's own blocks.
--
-- revenue_lines() is the one definition. The daily report (and so the
-- dashboard, the reports overview and the KPI email), the flash report, the tax
-- summary, the group comparison and night audit all read it.
--
-- Run after 0043_validations_and_links.sql.
-- ============================================================================

-- ── 1. Tips are classed, and paid-outs and tips are not supplies ────────────

do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'folio_entries'::regclass and contype = 'c'
     and pg_get_constraintdef(oid) like '%revenue_dept%';
  if c is not null then
    execute format('alter table folio_entries drop constraint %I', c);
  end if;
  alter table folio_entries add constraint folio_entries_revenue_dept_check
    check (revenue_dept in ('rooms', 'fnb', 'laundry', 'spa', 'events', 'other', 'paid_out', 'tip'));
end;
$$;

/*
 * As 0036, plus: the tip line pos_charge_to_room posts ("<outlet> — <bill> —
 * tip") is the staff's money passing through the bill, not a sale.
 */
create or replace function folio_charge_class(
  p_property uuid, p_kind text, p_description text, p_reference text
) returns table (dept text, sac text)
language plpgsql stable security definer set search_path = public as $$
declare
  v_p      record;
  v_outlet record;
begin
  select sac_room, sac_fnb, sac_event, sac_other into v_p from properties where id = p_property;

  if p_kind in ('room', 'fee', 'penalty') then
    return query select 'rooms'::text, coalesce(v_p.sac_room, '');
    return;
  end if;

  if p_kind <> 'extra' then
    return query select null::text, ''::text;
    return;
  end if;

  if p_description like 'Paid out: %' then
    return query select 'paid_out'::text, ''::text;
    return;
  end if;

  if p_description like '% — tip' and coalesce(p_reference, '') <> ''
     and exists (select 1 from pos_orders where number = p_reference and property_id = p_property) then
    return query select 'tip'::text, ''::text;
    return;
  end if;

  if coalesce(p_reference, '') <> '' then
    select o.kind, o.sac_code into v_outlet
      from pos_orders po join pos_outlets o on o.id = po.outlet_id
     where po.number = p_reference and po.property_id = p_property
     limit 1;
    if found then
      return query select
        case when v_outlet.kind in ('restaurant', 'bar', 'room_service', 'mini_bar') then 'fnb'
             when v_outlet.kind = 'laundry' then 'laundry'
             when v_outlet.kind = 'spa' then 'spa'
             else 'other' end,
        coalesce(nullif(v_outlet.sac_code, ''),
                 case when v_outlet.kind in ('restaurant', 'bar', 'room_service', 'mini_bar')
                      then v_p.sac_fnb else v_p.sac_other end, '');
      return;
    end if;

    if exists (select 1 from event_bookings where number = p_reference and property_id = p_property) then
      return query select 'events'::text, coalesce(v_p.sac_event, '');
      return;
    end if;
  end if;

  return query select 'other'::text, coalesce(v_p.sac_other, '');
end;
$$;

-- Tip lines already posted (folio_entries_guard freezes posted lines, so it
-- steps aside for this one reclassification).
alter table folio_entries disable trigger folio_entries_guard;
update folio_entries f
   set revenue_dept = 'tip', sac_code = ''
 where f.kind = 'extra'
   and f.description like '% — tip'
   and coalesce(f.reference, '') <> ''
   and coalesce(f.revenue_dept, '') <> 'tip'
   and exists (select 1 from pos_orders po where po.number = f.reference and po.property_id = f.property_id);
-- Allowances inherit their charge's department.
update folio_entries a
   set revenue_dept = c.revenue_dept, sac_code = c.sac_code
  from folio_entries c
 where a.applies_to = c.id and c.revenue_dept = 'tip' and a.revenue_dept is distinct from 'tip';
alter table folio_entries enable trigger folio_entries_guard;

-- One test for "is this a sale?" that every report shares (the invoice
-- builder applies the same rule to revenue_dept, app/lib/invoices.ts).
create or replace function is_supply(p_dept text)
returns boolean language sql immutable as $$
  select coalesce(p_dept, '') not in ('paid_out', 'tip');
$$;

-- ── 2. Rooms available on a night ───────────────────────────────────────────

/*
 * Every room, less those out of order that night. An out-of-service room (a
 * short fix) stays in the count, as USALI has it; out-of-order is a room taken
 * out of inventory. Read from the blocks, so a past or future night counts its
 * own blocks, not today's room statuses.
 */
create or replace function sellable_rooms(p_day date, p_property uuid default null)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int
    from rooms r
   where r.property_id = coalesce(p_property, current_property())
     and not exists (
       select 1 from room_blocks rb
        where rb.room_id = r.id
          and rb.kind = 'out_of_order'
          and rb.start_date <= p_day
          and (rb.end_date is null or rb.end_date >= p_day)
          and (rb.released_at is null or local_day(rb.released_at) > p_day));
$$;

create or replace function sellable_rooms()
returns int language sql stable security definer set search_path = public as $$
  select sellable_rooms((select business_date from properties where id = current_property()));
$$;

grant execute on function sellable_rooms(date, uuid) to authenticated, service_role;

-- ── 3. Revenue, one definition ──────────────────────────────────────────────

/*
 * Every line of revenue in a period, before tax, with its department, SAC,
 * rate and tax. `room_night` marks the room nights themselves (and allowances
 * and credit notes against them), which is what ADR and RevPAR divide.
 *
 *   folio charges          by the night or day they belong to
 *   allowances             on the day they were given
 *   outlet bills           settled at the outlet, by when they were settled;
 *                          a bill charged to a room is on the folio already
 *   events                 that carry their own bill, by the event date
 *   credit notes           on the day they were issued
 *
 * Paid-outs and tips are not supplies and appear nowhere. Internal: the
 * reports that call it check the permission.
 */
create or replace function revenue_lines(p_property uuid, p_from date, p_to date)
returns table (day date, dept text, sac text, rate numeric, net numeric, tax numeric, igst numeric, room_night boolean)
language sql stable security definer set search_path = public as $$
  with p as (
    select sac_fnb, sac_event, sac_other from properties where id = p_property
  ),
  outlet_bills as (
    select po.id, po.service_net, po.service_tax,
           local_day(coalesce(po.closed_at, po.opened_at)) as day,
           o.tax_rate as outlet_rate,
           case when o.kind in ('restaurant', 'bar', 'room_service', 'mini_bar') then 'fnb'
                when o.kind = 'laundry' then 'laundry'
                when o.kind = 'spa' then 'spa'
                else 'other' end as dept,
           coalesce(nullif(o.sac_code, ''),
                    case when o.kind in ('restaurant', 'bar', 'room_service', 'mini_bar')
                         then (select sac_fnb from p) else (select sac_other from p) end, '') as sac
      from pos_orders po
      join pos_outlets o on o.id = po.outlet_id
     where po.status = 'settled'
       and po.property_id = p_property
       and local_day(coalesce(po.closed_at, po.opened_at)) between p_from and p_to
       and not exists (
         select 1 from pos_payments pp
          where pp.order_id = po.id and pp.kind = 'room_charge' and pp.voided_at is null)
  ),
  own_bill_events as (
    select e.*
      from event_bookings e
     where e.status in ('confirmed', 'completed')
       and e.property_id = p_property
       and e.event_date between p_from and p_to
       and not exists (
         select 1 from event_payments ep
          where ep.event_id = e.id and ep.kind = 'room_charge' and ep.voided_at is null)
  )
  -- Charges on folios.
  select coalesce(f.stay_date, local_day(f.created_at)), coalesce(f.revenue_dept, 'other'), f.sac_code,
         f.tax_rate, f.amount, f.tax_amount, 0::numeric, f.kind = 'room'
    from folio_entries f
   where f.voided_at is null
     and f.property_id = p_property
     and f.kind in ('room', 'fee', 'penalty', 'extra')
     and is_supply(f.revenue_dept)
     and coalesce(f.stay_date, local_day(f.created_at)) between p_from and p_to
  union all
  -- Allowances against a charge come off that charge's department.
  select local_day(f.created_at), coalesce(f.revenue_dept, 'other'), f.sac_code,
         f.tax_rate, -(f.amount - f.tax_amount), -f.tax_amount, 0::numeric,
         coalesce((select c.kind = 'room' from folio_entries c where c.id = f.applies_to), false)
    from folio_entries f
   where f.voided_at is null
     and f.property_id = p_property
     and f.kind = 'adjustment' and f.applies_to is not null
     and is_supply(f.revenue_dept)
     and local_day(f.created_at) between p_from and p_to
  union all
  -- Outlet bills settled at the outlet: their lines, then the service charge.
  -- The tip is the staff's.
  select ob.day, ob.dept, ob.sac, l.tax_rate, l.net_amount, l.tax_amount, 0::numeric, false
    from outlet_bills ob
    join pos_order_lines l on l.order_id = ob.id and l.voided_at is null
  union all
  select ob.day, ob.dept, ob.sac, ob.outlet_rate, ob.service_net, ob.service_tax, 0::numeric, false
    from outlet_bills ob
   where ob.service_net > 0
  union all
  -- Events that carry their own bill, by tax band.
  select e.event_date, 'events', coalesce((select sac_event from p), ''),
         (b ->> 'rate')::numeric, (b ->> 'net')::numeric, (b ->> 'tax')::numeric, 0::numeric, false
    from own_bill_events e
    cross join lateral jsonb_array_elements(e.tax_breakdown) b
  union all
  select e.event_date, 'events', coalesce((select sac_event from p), ''), 0::numeric, e.net_total, e.tax_total, 0::numeric, false
    from own_bill_events e
   where jsonb_array_length(coalesce(e.tax_breakdown, '[]'::jsonb)) = 0
  union all
  -- Credit notes reduce the period they are issued in.
  select local_day(c.issued_at), coalesce(l ->> 'dept', 'other'), coalesce(l ->> 'sac', ''),
         coalesce((l ->> 'rate')::numeric, 0), -(l ->> 'net')::numeric, -(l ->> 'tax')::numeric,
         -coalesce((l ->> 'igst')::numeric, 0),
         coalesce((i.lines -> ((l ->> 'line')::int) ->> 'kind') = 'room', false)
    from credit_notes c
    left join invoices i on i.id = c.invoice_id
    cross join lateral jsonb_array_elements(c.lines) l
   where c.property_id = p_property
     and local_day(c.issued_at) between p_from and p_to
     and coalesce(l ->> 'dept', 'other') not in ('paid_out', 'tip');
$$;

revoke execute on function revenue_lines(uuid, date, date) from public, anon, authenticated;
grant execute on function revenue_lines(uuid, date, date) to service_role;

-- ── 4. The daily report ─────────────────────────────────────────────────────

/*
 * As 0031, with revenue from revenue_lines and rooms available from the
 * night's blocks. A day night audit closed keeps the figures it froze; for a
 * day closed before 0044 only rooms and room revenue are kept, and tax and the
 * rest of revenue are read from the lines (which can no longer change on a
 * closed day, 0039/0040). Either way room + other = total − tax.
 * total_revenue stays tax-inclusive, as callers expect.
 */
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
  ),
  lines as (
    select l.day,
           sum(l.net) as net,
           sum(l.tax) as tax,
           sum(l.net) filter (where l.room_night) as room
      from revenue_lines(v_property, p_from, p_to) l
     group by l.day
  ),
  base as (
    select days.day,
           a.report,
           -- A day closed since 0044 carries its net and tax and is used as
           -- frozen; one closed earlier stored the old definition, so its
           -- revenue other than rooms is read from the lines.
           coalesce((a.report -> 'revenue' ->> 'net')::numeric, lines.net, 0) as net,
           coalesce(case when a.report -> 'revenue' ? 'net' then (a.report -> 'revenue' ->> 'tax')::numeric end,
                    lines.tax, 0) as tax,
           coalesce((a.report -> 'revenue' ->> 'room')::numeric, lines.room, 0) as room
      from days
      left join audited a on a.business_date = days.day
      left join lines on lines.day = days.day
  )
  select
    base.day,
    case when base.report is not null then 'audit' else 'live' end,
    coalesce((base.report -> 'rooms' ->> 'available')::int, sellable_rooms(base.day, v_property)),
    coalesce(
      (base.report -> 'rooms' ->> 'sold')::int,
      (select coalesce(sum(b.rooms_count), 0)::int
         from bookings b
        where b.check_in <= base.day and b.check_out > base.day
          and b.property_id = v_property
          and b.status in ('checked_in', 'checked_out')
          and b.stay_type = 'paid')),
    round(base.room, 2),
    round(base.net - base.room, 2),
    round(base.tax, 2),
    round(base.net + base.tax, 2)
  from base
  order by base.day;
end;
$$;

-- ── 5. Flash report ─────────────────────────────────────────────────────────

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

  select coalesce(sum(b.rooms_count) filter (where b.stay_type = 'complimentary'), 0)::int,
         coalesce(sum(b.rooms_count) filter (where b.stay_type = 'house_use'), 0)::int
    into v_comp, v_house
    from bookings b
    cross join lateral generate_series(greatest(b.check_in, p_from), least(b.check_out - 1, p_to), interval '1 day') n
   where b.property_id = v_property
     and b.status in ('checked_in', 'checked_out')
     and b.stay_type <> 'paid'
     and b.check_in <= p_to and b.check_out > p_from;

  -- A day night audit closed since 0044 reads the departments it froze, as
  -- report_daily does, so the two always agree; other days read the lines.
  with frozen as (
    select na.business_date, na.report -> 'revenue' as rev
      from night_audits na
     where na.status = 'completed'
       and na.property_id = v_property
       and na.business_date between p_from and p_to
       and na.report -> 'revenue' ? 'net'
  ),
  rows as (
    select l.dept, l.net, l.tax
      from revenue_lines(v_property, p_from, p_to) l
     where l.day not in (select business_date from frozen)
    union all
    select d.key, d.value::numeric, 0
      from frozen f cross join lateral jsonb_each_text(coalesce(f.rev -> 'by_dept', '{}'::jsonb)) d
    union all
    select 'other', 0, (f.rev ->> 'tax')::numeric from frozen f
  )
  select coalesce(jsonb_object_agg(dept, total) filter (where total <> 0 or dept <> 'other'), '{}'::jsonb), coalesce(sum(t), 0)
    into v_revenue, v_tax
    from (select r.dept, round(sum(r.net), 2) as total, sum(r.tax) as t from rows r group by r.dept) x;

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
       and rb.kind = 'out_of_order'
       and rb.start_date <= p_date
       and (rb.end_date is null or rb.end_date >= p_date)
       and (rb.released_at is null or local_day(rb.released_at) > p_date)));

  -- The week ahead as it stands on the books now, each night with its own
  -- blocks.
  select coalesce(jsonb_agg(jsonb_build_object(
           'day', d.day,
           'rooms_sold', d.sold,
           'rooms_available', sellable_rooms(d.day, v_property)) order by d.day), '[]'::jsonb)
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

-- ── 6. Tax summary ──────────────────────────────────────────────────────────

/*
 * Tax on the supplies made in a period, by SAC and rate: the same lines as
 * the revenue figures, so net here equals revenue there. The GST register is
 * a different document: it lists invoices by the date they were issued.
 */
create or replace function report_tax_summary(p_from date, p_to date)
returns table (sac text, rate numeric, net numeric, cgst numeric, sgst numeric, igst numeric, tax numeric, entries int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid := current_property();
  v_regime   text;
begin
  if not (has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  select tax_regime into v_regime from properties where id = v_property;

  return query
  select l.sac::text,
         l.rate,
         round(sum(l.net), 2),
         case when v_regime = 'gst' then round(sum(l.tax - l.igst) / 2, 2) else 0 end,
         case when v_regime = 'gst'
              then round(sum(l.tax - l.igst), 2) - round(sum(l.tax - l.igst) / 2, 2) else 0 end,
         round(sum(l.igst), 2),
         round(sum(l.tax), 2),
         count(*)::int
    from revenue_lines(v_property, p_from, p_to) l
   group by l.sac, l.rate
   order by l.sac, l.rate;
end;
$$;

-- ── 7. Comparing the hotels in a group ──────────────────────────────────────

/*
 * As 0024, on the same definitions: rooms available from each night's blocks,
 * paid stays only in rooms sold, and revenue (before tax) from revenue_lines.
 */
create or replace function group_dashboard(p_from date, p_to date)
returns table (
  property_id     uuid,
  code            text,
  name            text,
  brand           text,
  nights          int,
  rooms_available int,
  rooms_sold      int,
  occupancy       numeric,
  room_revenue    numeric,
  total_revenue   numeric,
  adr             numeric,
  revpar          numeric
) language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('properties.view') or has_permission('reports.view')
          or has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;
  if p_to < p_from then
    raise exception 'GROUP_BAD_RANGE' using hint = 'The end of the range comes before its start.';
  end if;
  if p_to - p_from > 400 then
    raise exception 'GROUP_RANGE_TOO_LONG' using hint = 'Ask for at most 400 nights at a time.';
  end if;

  return query
  with mine as (
    select pr.* from properties pr
     where pr.id in (select staff_property_ids()) or is_service_role()
  ),
  nights as (
    select d::date as stay_date from generate_series(p_from, p_to, interval '1 day') d
  ),
  capacity as (
    select m.id as pid, sum(sellable_rooms(n.stay_date, m.id))::int as available
      from mine m cross join nights n
     group by m.id
  ),
  sold as (
    select b.property_id as pid, coalesce(sum(b.rooms_count), 0)::int as rooms_sold
      from bookings b
      join nights n on b.check_in <= n.stay_date and b.check_out > n.stay_date
     where b.status in ('checked_in', 'checked_out')
       and b.stay_type = 'paid'
     group by b.property_id
  ),
  revenue as (
    select m.id as pid,
           coalesce(sum(l.net) filter (where l.room_night), 0) as room_revenue,
           coalesce(sum(l.net), 0)                             as total_revenue
      from mine m
      cross join lateral revenue_lines(m.id, p_from, p_to) l
     group by m.id
  )
  select m.id, m.code, m.name, m.brand,
         (p_to - p_from + 1)::int,
         c.available,
         coalesce(s.rooms_sold, 0),
         case when c.available > 0
              then round(coalesce(s.rooms_sold, 0)::numeric / c.available * 100, 1) else 0 end,
         round(coalesce(r.room_revenue, 0), 2),
         round(coalesce(r.total_revenue, 0), 2),
         case when coalesce(s.rooms_sold, 0) > 0
              then round(coalesce(r.room_revenue, 0) / s.rooms_sold, 2) else 0 end,
         case when c.available > 0
              then round(coalesce(r.room_revenue, 0) / c.available, 2) else 0 end
    from mine m
    join capacity c on c.pid = m.id
    left join sold s on s.pid = m.id
    left join revenue r on r.pid = m.id
   order by m.sort_order, m.name;
end;
$$;

-- ── 8. Night audit: the day's revenue on the same definition ────────────────

/*
 * What night audit freezes into its report, so a closed day reads the same in
 * the audit, the daily report and the flash report. Before tax, except total.
 */
create or replace function night_audit_revenue(p_day date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid := current_property();
  v_out      jsonb;
begin
  if not (has_permission('frontdesk.night_audit') or has_permission('reports.financial')
          or has_permission('reports.view') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  select jsonb_build_object(
           'room',  round(coalesce(sum(l.net) filter (where l.room_night), 0), 2),
           'other', round(coalesce(sum(l.net) filter (where not l.room_night), 0), 2),
           'net',   round(coalesce(sum(l.net), 0), 2),
           'tax',   round(coalesce(sum(l.tax), 0), 2),
           'total', round(coalesce(sum(l.net + l.tax), 0), 2),
           'by_dept', coalesce((
             select jsonb_object_agg(x.dept, x.total)
               from (select l2.dept, round(sum(l2.net), 2) as total
                       from revenue_lines(v_property, p_day, p_day) l2 group by l2.dept) x), '{}'::jsonb))
    into v_out
    from revenue_lines(v_property, p_day, p_day) l;
  return v_out;
end;
$$;

revoke execute on function night_audit_revenue(date) from public, anon;
grant execute on function night_audit_revenue(date) to authenticated, service_role;

-- ── 9. Invoice totals for a financial year ──────────────────────────────────

/*
 * The figures at the top of the invoices page, summed in the database (the
 * page used to read every invoice and stopped at the row cap), net of the
 * credit notes issued in the same financial year.
 */
create or replace function invoice_year_totals(p_fy text)
returns table (issued int, cancelled int, billed numeric, tax numeric, credited numeric)
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid := current_property();
begin
  if not (has_permission('folio.view') or has_permission('folio.invoice')
          or has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  return query
  with inv as (
    select count(*) filter (where i.status = 'issued')::int as issued,
           count(*) filter (where i.status = 'cancelled')::int as cancelled,
           coalesce(sum(i.grand_total) filter (where i.status = 'issued'), 0) as gross,
           coalesce(sum(i.tax_total) filter (where i.status = 'issued'), 0) as tax
      from invoices i
     where i.financial_year = p_fy and i.property_id = v_property
  ),
  cn as (
    select coalesce(sum(c.grand_total), 0) as gross, coalesce(sum(c.tax_total), 0) as tax
      from credit_notes c
     where c.financial_year = p_fy and c.property_id = v_property
  )
  select inv.issued, inv.cancelled,
         round(inv.gross - cn.gross, 2), round(inv.tax - cn.tax, 2), round(cn.gross, 2)
    from inv, cn;
end;
$$;

revoke execute on function invoice_year_totals(text) from public, anon;
grant execute on function invoice_year_totals(text) to authenticated, service_role;

-- ── 10. Staff: tasks done, and hours ────────────────────────────────────────

/*
 * Cleans finished and maintenance tickets resolved per person since a time,
 * for the HR pages. Read with the viewer's own access, an HR manager without
 * housekeeping or maintenance access saw 0 for everyone.
 */
create or replace function staff_task_counts(p_since timestamptz)
returns table (staff_id uuid, hk_done int, hk_first_time int, mt_resolved int, mt_on_time int)
language plpgsql stable security definer set search_path = public as $$
declare v_property uuid := current_property();
begin
  if not (has_permission('hr.view') or has_permission('hr.manage') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  return query
  with hk as (
    select t.completed_by as sid, count(*)::int as done,
           count(*) filter (where t.status = 'inspected' and t.failed_count = 0)::int as first_time
      from housekeeping_tasks t
     where t.property_id = v_property and t.completed_by is not null and t.completed_at >= p_since
     group by t.completed_by
  ),
  mt as (
    select t.resolved_by as sid, count(*)::int as resolved,
           count(*) filter (where t.due_at is not null and t.resolved_at <= t.due_at)::int as on_time
      from maintenance_tickets t
     where t.property_id = v_property and t.status = 'resolved'
       and t.resolved_by is not null and t.resolved_at >= p_since
     group by t.resolved_by
  )
  select coalesce(hk.sid, mt.sid), coalesce(hk.done, 0), coalesce(hk.first_time, 0),
         coalesce(mt.resolved, 0), coalesce(mt.on_time, 0)
    from hk full join mt on mt.sid = hk.sid;
end;
$$;

revoke execute on function staff_task_counts(timestamptz) from public, anon;
grant execute on function staff_task_counts(timestamptz) to authenticated, service_role;

-- Hours to two decimals, as the timesheets show them.
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
         (select round(coalesce(sum(extract(epoch from (a.clock_out - a.clock_in)) / 3600), 0), 2)
            from attendance a
           where a.staff_id = p.id and a.property_id = v_property
             and a.work_date between p_from and p_to and a.clock_out is not null)
    from people p
   order by p.full_name;
end;
$$;

-- ── 11. Events: anyone who works on events can read them (section 5) ───────
--
-- The events pages admit quoting, approving and billing as well as viewing
-- (0044), but these tables let only events.view (or folio.view) read, so a
-- role with, say, events.bill alone was let in to an empty page. Every seeded
-- role that holds those also holds events.view; a hotel's own roles may not.

create or replace function can_read_events()
returns boolean language sql stable security definer set search_path = public as $$
  select has_permission('events.view') or has_permission('events.book') or has_permission('events.quote')
      or has_permission('events.approve') or has_permission('events.bill') or has_permission('events.manage')
      or has_permission('folio.view');
$$;

drop policy if exists event_bookings_select on event_bookings;
create policy event_bookings_select on event_bookings for select using (can_read_events());
drop policy if exists event_lines_select on event_lines;
create policy event_lines_select on event_lines for select using (can_read_events());
drop policy if exists event_payments_select on event_payments;
create policy event_payments_select on event_payments for select using (can_read_events());
drop policy if exists event_series_select on event_series;
create policy event_series_select on event_series for select using (can_read_events());
