-- ============================================================================
-- Front Office & Operations build-out, part 6: operations
--
--   1. Stay-over cleaning is back, as a per-property setting
--      (properties.hk_stayover_enabled). 0010 removed it for the original
--      client; a standard PMS has it. Night audit, or the board's button,
--      creates the next day's stay-over task for every room staying on.
--   2. Room discrepancies: housekeeping reports each room occupied or vacant,
--      and room_discrepancies lists where that disagrees with the front desk
--      — a skip (desk says occupied, room is empty: the guest may have left
--      without paying) or a sleeper (desk says vacant, someone is in it).
--   3. A room block refuses to cover a room with a guest assigned, in the
--      database too, under the same room lock the booking trigger takes.
--   4. Minibar and laundry from housekeeping: hk_post_consumption() opens a
--      bill at the property's mini-bar or laundry outlet, adds the items and
--      charges it to the guest in the room, in one transaction. Laundry
--      bills carry a laundry_status (collected → processing → delivered).
--   5. Charge to room no longer charges twice what was already paid at the
--      outlet (docs/pms-review.md §1.9).
--   6. POS bill lines are frozen once the bill is billed, settled or void,
--      and are audited.
--
-- Permissions:
--   housekeeping.post_charges  post minibar and laundry to a guest's room.
--   frontdesk.checkin_override check a guest into a room not yet inspected.
--
-- Run after 0031_front_desk_extras.sql.
-- ============================================================================

-- ── 1. Stay-over cleaning ───────────────────────────────────────────────────

alter table properties add column if not exists hk_stayover_enabled boolean not null default false;

create or replace view property_settings with (security_invoker = true) as
  select * from properties where id = current_property();

create or replace function hk_generate_tasks(p_date date)
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  v_count    int := 0;
  v_room     record;
  v_days     int := coalesce((select hk_deep_clean_days from property_settings limit 1), 30);
  v_stayover boolean := coalesce((select hk_stayover_enabled from property_settings limit 1), false);
begin
  if not (has_permission('housekeeping.assign') or has_permission('frontdesk.night_audit')) then
    raise exception 'not permitted';
  end if;

  -- Deep cleans that have fallen due (as 0024).
  for v_room in
    select r.id from rooms r
     where r.status not in ('out_of_order', 'out_of_service')
       and r.property_id = current_property()
       and (r.last_deep_clean_on is null or r.last_deep_clean_on + v_days <= p_date)
       and not exists (select 1 from housekeeping_tasks t where t.room_id = r.id and t.kind = 'deep_clean'
                        and t.status in ('pending', 'in_progress', 'cleaned'))
  loop
    if hk_create_task(v_room.id, 'deep_clean', p_date, 'Scheduled deep clean') is not null then
      v_count := v_count + 1;
    end if;
  end loop;

  -- Stay-overs: every room whose guest arrived before p_date and leaves after
  -- it. Departures get their check-out clean when they leave instead.
  if v_stayover then
    for v_room in
      select distinct b.room_id as id
        from bookings b
       where b.status = 'checked_in'
         and b.property_id = current_property()
         and b.room_id is not null
         and b.check_in < p_date
         and b.check_out > p_date
         and not exists (select 1 from housekeeping_tasks t
                          where t.room_id = b.room_id and t.task_date = p_date and t.kind = 'stayover')
    loop
      if hk_create_task(v_room.id, 'stayover', p_date, 'Daily service') is not null then
        v_count := v_count + 1;
      end if;
    end loop;
  end if;

  return v_count;
end;
$$;

-- ── 2. Room discrepancies ───────────────────────────────────────────────────

create table if not exists hk_room_reports (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null default current_property() references properties on delete restrict,
  room_id     uuid not null references rooms on delete cascade,
  report_date date not null,
  reported    text not null check (reported in ('occupied', 'vacant')),
  luggage     boolean not null default false,
  notes       text not null default '',
  reported_by uuid references staff on delete set null,
  reported_at timestamptz not null default now(),
  unique (room_id, report_date)
);

create index if not exists hk_room_reports_day_idx on hk_room_reports (property_id, report_date);

/* What a room attendant saw in the room today. The latest report counts. */
create or replace function hk_report_room(p_room uuid, p_reported text, p_luggage boolean default false, p_notes text default '')
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not (has_permission('housekeeping.tasks') or has_permission('housekeeping.inspect') or has_permission('rooms.status')) then
    raise exception 'not permitted';
  end if;
  if p_reported not in ('occupied', 'vacant') then
    raise exception 'HK_BAD_REPORT: a room is reported occupied or vacant';
  end if;
  if not exists (select 1 from rooms where id = p_room and property_id = current_property()) then
    raise exception 'HK_NO_ROOM: that room is not at this property';
  end if;

  insert into hk_room_reports (room_id, report_date, reported, luggage, notes, reported_by)
  values (p_room, hk_business_today(), p_reported, coalesce(p_luggage, false), coalesce(p_notes, ''), auth.uid())
  on conflict (room_id, report_date) do update
     set reported = excluded.reported, luggage = excluded.luggage, notes = excluded.notes,
         reported_by = excluded.reported_by, reported_at = now()
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * Today's reports that disagree with the front desk. security_invoker, so the
 * caller's own row level security decides what they see.
 */
create or replace view room_discrepancies with (security_invoker = true) as
  select r.id as room_id, r.room_number, r.property_id,
         hr.reported, hr.luggage, hr.notes, hr.reported_at, hr.reported_by,
         case when fo.booking_id is not null then 'occupied' else 'vacant' end as front_desk,
         case when fo.booking_id is not null and hr.reported = 'vacant' then 'skip'
              else 'sleeper' end as kind,
         fo.booking_id, fo.reference, fo.contact_name
    from hk_room_reports hr
    join rooms r on r.id = hr.room_id
    left join lateral (
      select b.id as booking_id, b.reference, b.contact_name
        from bookings b
       where b.room_id = r.id and b.status = 'checked_in'
       limit 1
    ) fo on true
   where hr.report_date = hk_business_today()
     and ((fo.booking_id is not null and hr.reported = 'vacant')
       or (fo.booking_id is null and hr.reported = 'occupied'));

alter table hk_room_reports enable row level security;
drop policy if exists hk_room_reports_select   on hk_room_reports;
drop policy if exists hk_room_reports_property on hk_room_reports;
create policy hk_room_reports_select on hk_room_reports for select
  using (has_permission('housekeeping.tasks') or has_permission('housekeeping.inspect')
         or has_permission('rooms.view') or has_permission('frontdesk.view'));
create policy hk_room_reports_property on hk_room_reports as restrictive for all
  using (can_access_property(property_id)) with check (can_access_property(property_id));

-- ── 3. Blocks never cover a room with a guest in it ─────────────────────────

create or replace function room_blocks_no_guest()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ref text;
begin
  if new.released_at is not null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('room:' || new.room_id::text, 0));
  select b.reference into v_ref
    from bookings b
   where b.room_id = new.room_id
     and b.status in ('tentative', 'confirmed', 'checked_in')
     and b.check_out > new.start_date
     and (new.end_date is null or b.check_in <= new.end_date)
   limit 1;
  if v_ref is not null then
    raise exception 'ROOM_IN_USE: %', v_ref;
  end if;
  return new;
end;
$$;

drop trigger if exists room_blocks_no_guest on room_blocks;
create trigger room_blocks_no_guest before insert on room_blocks
  for each row execute function room_blocks_no_guest();

-- ── 4. Minibar and laundry from housekeeping ────────────────────────────────

alter table pos_orders add column if not exists laundry_status text not null default ''
  check (laundry_status in ('', 'collected', 'processing', 'delivered'));

/* POS staff at any outlet; housekeeping at the mini-bar and laundry only. */
create or replace function pos_may_order(p_outlet uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select has_permission('pos.order')
      or (has_permission('housekeeping.post_charges')
          and exists (select 1 from pos_outlets where id = p_outlet and kind in ('mini_bar', 'laundry')));
$$;

create or replace function pos_may_pay(p_outlet uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select has_permission('pos.pay')
      or (has_permission('housekeeping.post_charges')
          and exists (select 1 from pos_outlets where id = p_outlet and kind in ('mini_bar', 'laundry')));
$$;

-- Re-issued from 0017 with pos_may_order()/pos_may_pay() in place of the bare
-- permission check; otherwise unchanged except where marked.

create or replace function pos_open_order(
  p_outlet   uuid,
  p_table    text default '',
  p_room     uuid default null,
  p_booking  uuid default null,
  p_guest    text default '',
  p_covers   int default 1
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_code   text;
  v_seq    int;
  v_order  uuid;
begin
  if not pos_may_order(p_outlet) then
    raise exception 'not permitted';
  end if;

  select code into v_code from pos_outlets where id = p_outlet and is_active;
  if v_code is null then
    raise exception 'POS_NO_OUTLET' using hint = 'Choose an outlet that is open for business.';
  end if;

  v_seq := next_pos_order_number(p_outlet);

  insert into pos_orders (number, outlet_id, table_no, room_id, booking_id, guest_name, covers, opened_by)
  values (v_code || '/' || lpad(v_seq::text, 6, '0'), p_outlet, coalesce(p_table, ''), p_room,
          p_booking, coalesce(p_guest, ''), greatest(coalesce(p_covers, 1), 0), auth.uid())
  returning id into v_order;

  return v_order;
end;
$$;

create or replace function pos_add_line(
  p_order     uuid,
  p_item      uuid,
  p_qty       numeric,
  p_modifiers uuid[] default '{}',
  p_notes     text default ''
)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_item   record;
  v_status text;
  v_rate   numeric(5,2);
  v_delta  numeric(12,2) := 0;
  v_mods   jsonb := '[]';
  v_unit   numeric(12,2);
  v_gross  numeric(12,2);
  v_net    numeric(12,2);
  v_tax    numeric(12,2);
  v_incl   boolean;
  v_line   uuid;
begin
  if not pos_may_order((select outlet_id from pos_orders where id = p_order)) then
    raise exception 'not permitted';
  end if;
  if coalesce(p_qty, 0) <= 0 then
    raise exception 'POS_QTY_INVALID' using hint = 'Enter how many.';
  end if;

  select status into v_status from pos_orders where id = p_order;
  if v_status is null then
    raise exception 'POS_NO_ORDER' using hint = 'That bill no longer exists.';
  end if;
  if v_status <> 'open' then
    raise exception 'POS_ORDER_CLOSED'
      using hint = 'This bill is no longer open. Open a new one for anything else ordered.';
  end if;

  select i.*, o.tax_inclusive into v_item
    from pos_items i join pos_outlets o on o.id = i.outlet_id
   where i.id = p_item and i.is_active;
  if v_item is null then
    raise exception 'POS_NO_ITEM' using hint = 'That item is not on the menu.';
  end if;
  if not exists (select 1 from pos_orders where id = p_order and outlet_id = v_item.outlet_id) then
    raise exception 'POS_ITEM_WRONG_OUTLET'
      using hint = 'That item belongs to another outlet''s menu.';
  end if;

  v_incl := v_item.tax_inclusive;
  v_rate := pos_item_tax_rate(p_item);

  -- Only modifiers that belong to this item may be applied.
  select coalesce(sum(m.price_delta), 0),
         coalesce(jsonb_agg(jsonb_build_object('name', m.name, 'price_delta', m.price_delta)), '[]')
    into v_delta, v_mods
    from pos_modifiers m
    join pos_item_modifiers im on im.modifier_id = m.id and im.item_id = p_item
   where m.id = any(coalesce(p_modifiers, '{}')) and m.is_active;

  v_unit  := v_item.price + coalesce(v_delta, 0);
  v_gross := round(v_unit * p_qty, 2);

  -- A tax-inclusive menu price has the tax taken back out of it, so the folio
  -- and the invoice always show net and tax separately.
  if v_incl and v_rate > 0 then
    v_net := round(v_gross / (1 + v_rate / 100), 2);
    v_tax := v_gross - v_net;
  else
    v_net := v_gross;
    v_tax := round(v_gross * v_rate / 100, 2);
  end if;

  insert into pos_order_lines (
    order_id, item_id, name, qty, unit_price, modifiers, notes,
    net_amount, tax_rate, tax_amount, created_by
  ) values (
    p_order, p_item, v_item.name, p_qty, v_unit, coalesce(v_mods, '[]'), coalesce(p_notes, ''),
    v_net, v_rate, v_tax, auth.uid()
  )
  returning id into v_line;

  return v_line;
end;
$$;

-- ── 5. Charge to room, without charging twice ───────────────────────────────

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

  select * into v_order from pos_orders where id = p_order;
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

  -- The property's cap on how much outlet spend one stay may carry unpaid.
  select pos_room_charge_limit into v_limit from property_settings limit 1;
  if coalesce(v_limit, 0) > 0 then
    select coalesce(sum(p.amount), 0) into v_posted
      from pos_payments p
     where p.kind = 'room_charge' and p.voided_at is null and p.booking_id = p_booking;
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

/*
 * Posts what housekeeping found used in a room — minibar items, a laundry
 * bag — to the guest staying there: one bill at the property's mini-bar or
 * laundry outlet, charged to the room, all or nothing.
 *
 * p_items: [{"item_id": "...", "qty": 2}, ...]
 */
create or replace function hk_post_consumption(p_room uuid, p_outlet_kind text, p_items jsonb, p_notes text default '')
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_outlet  uuid;
  v_booking record;
  v_order   uuid;
  v_item    jsonb;
  v_lines   int := 0;
begin
  if p_outlet_kind not in ('mini_bar', 'laundry') then
    raise exception 'HK_BAD_OUTLET: only minibar and laundry are posted from housekeeping';
  end if;
  select id into v_outlet from pos_outlets
   where kind = p_outlet_kind and is_active and property_id = current_property()
   order by sort_order limit 1;
  if v_outlet is null then
    raise exception 'POS_NO_OUTLET' using hint = 'Switch on the property''s mini-bar or laundry outlet under Point of sale first.';
  end if;
  if not pos_may_order(v_outlet) then
    raise exception 'not permitted';
  end if;

  select b.id, b.contact_name into v_booking
    from bookings b
   where b.room_id = p_room and b.status = 'checked_in'
   limit 1;
  if v_booking.id is null then
    raise exception 'POS_NOT_CHECKED_IN' using hint = 'Nobody is checked in to this room.';
  end if;

  v_order := pos_open_order(v_outlet, '', p_room, v_booking.id, v_booking.contact_name, 1);

  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce((v_item ->> 'qty')::numeric, 0) > 0 then
      perform pos_add_line(v_order, (v_item ->> 'item_id')::uuid, (v_item ->> 'qty')::numeric, '{}', coalesce(p_notes, ''));
      v_lines := v_lines + 1;
    end if;
  end loop;
  if v_lines = 0 then
    raise exception 'POS_QTY_INVALID' using hint = 'Enter how many of at least one item.';
  end if;

  if p_outlet_kind = 'laundry' then
    update pos_orders set laundry_status = 'collected' where id = v_order;
  end if;

  perform pos_charge_to_room(v_order, v_booking.id, null);
  return v_order;
end;
$$;

-- Housekeeping tracks the laundry it collected, without seeing other bills.
drop policy if exists pos_orders_laundry_select on pos_orders;
create policy pos_orders_laundry_select on pos_orders for select
  using (laundry_status <> '' and (has_permission('housekeeping.post_charges') or has_permission('housekeeping.assign')));

/* Laundry moves collected → processing → delivered; housekeeping updates it. */
create or replace function pos_set_laundry_status(p_order uuid, p_status text)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not (has_permission('housekeeping.post_charges') or has_permission('pos.order')) then
    raise exception 'not permitted';
  end if;
  if p_status not in ('collected', 'processing', 'delivered') then
    raise exception 'POS_LAUNDRY_STATUS: %', p_status;
  end if;
  update pos_orders set laundry_status = p_status
   where id = p_order and laundry_status <> '' and property_id = current_property();
end;
$$;

-- ── 6. Bill lines are frozen once the bill is ───────────────────────────────

create or replace function pos_lines_frozen()
returns trigger language plpgsql as $$
declare
  v_status text;
  v_other  boolean;
begin
  select status into v_status from pos_orders where id = coalesce(new.order_id, old.order_id);
  if v_status is null or v_status = 'open' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    raise exception 'POS_ORDER_CLOSED' using hint = 'This bill is closed; void the line instead.';
  end if;
  -- Stamping the kitchen ticket is never a change to the bill.
  v_other := (to_jsonb(new) - array['kot_sent_at']) is distinct from (to_jsonb(old) - array['kot_sent_at']);
  if not v_other then return new; end if;
  -- A billed bill may still lose a line (a void reopens its balance, which the
  -- cashier settles); a settled or void one changes no further.
  if v_status = 'billed'
     and (to_jsonb(new) - array['kot_sent_at', 'voided_at', 'voided_by', 'void_reason'])
         is not distinct from (to_jsonb(old) - array['kot_sent_at', 'voided_at', 'voided_by', 'void_reason']) then
    return new;
  end if;
  raise exception 'POS_ORDER_CLOSED' using hint = 'This bill is closed and its lines can no longer change.';
end;
$$;

drop trigger if exists pos_order_lines_frozen on pos_order_lines;
create trigger pos_order_lines_frozen before update or delete on pos_order_lines
  for each row execute function pos_lines_frozen();

drop trigger if exists pos_order_lines_audit on pos_order_lines;
create trigger pos_order_lines_audit after insert or update or delete on pos_order_lines
  for each row execute function audit_row('pos');

-- ── Permissions ─────────────────────────────────────────────────────────────

insert into role_permissions (role_key, permission)
select r, p from (values
  ('housekeeping', 'housekeeping.post_charges'), ('housekeeping_supervisor', 'housekeeping.post_charges'),
  ('manager', 'housekeeping.post_charges'), ('front_office_manager', 'housekeeping.post_charges'),
  ('manager', 'frontdesk.checkin_override'), ('front_office_manager', 'frontdesk.checkin_override')
) as seed (r, p)
where exists (select 1 from roles where key = seed.r)
on conflict do nothing;
