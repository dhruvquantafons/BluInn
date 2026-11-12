-- ============================================================================
-- Two decisions from the 12 Nov review of docs/interconnection-audit-2026-11-07.md:
--
-- A. Events hold guest rooms. An event links to one group (booking_groups)
--    that holds its rooms. The rooms follow the event (tentative while it is
--    quoted, confirmed with it, released if it is cancelled), unsold rooms are
--    released at a cut-off date, and the organiser can pay for the rooms: their
--    nights then post to an "Organiser" folio that belongs to the event, count
--    in the event's balance and go on the event's GST invoice. They stay folio
--    room lines, so room revenue, ADR, the tax summary and night audit count
--    them as before.
--
-- B. An outlet till cannot sell more of a stock-tracked item than is on hand
--    at that outlet (less what open bills already hold). Minibar items posted
--    from housekeeping are never refused: the guest has already had them.
--
-- Run after 0041_data_flow.sql.
-- ============================================================================

-- ── A. Events hold rooms ────────────────────────────────────────────────────

alter table booking_groups add column if not exists event_id uuid references event_bookings on delete set null;
alter table booking_groups add column if not exists release_on date;
alter table booking_groups add column if not exists room_billing text not null default 'guest';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'booking_groups_room_billing') then
    alter table booking_groups add constraint booking_groups_room_billing check (room_billing in ('guest', 'organiser'));
  end if;
end;
$$;
create unique index if not exists booking_groups_event_idx on booking_groups (event_id) where event_id is not null;

-- The folio an organiser-paid room's nights post to.
alter table folios add column if not exists event_id uuid references event_bookings on delete restrict;
create index if not exists folios_event_idx on folios (event_id) where event_id is not null;

/*
 * A group room nobody has taken yet: it still carries the placeholder name
 * the group was made with ("<group> — room N") and no guest profile. The one
 * rule behind releasing unsold rooms and the pickup counts.
 */
create or replace function group_room_unnamed(p_booking uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select b.guest_id is null and b.contact_name like g.name || ' — room %'
      from bookings b join booking_groups g on g.id = b.group_id
     where b.id = p_booking), false);
$$;

/*
 * Holds rooms for an event: a group linked to it, one booking per room. The
 * caller prices the rooms (as createGroup does); capacity is checked by
 * enforce_booking_inventory as for any booking. Rooms are tentative while the
 * event is not confirmed and confirmed once it is. They have no hold_until:
 * they are released at the cut-off (release_on) or with the event, not by the
 * hour like an ordinary tentative booking.
 */
create or replace function event_hold_rooms(p_event uuid, p_group jsonb, p_rooms jsonb)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_e     event_bookings;
  v_group uuid;
begin
  if not has_permission('events.book') then raise exception 'not permitted'; end if;
  select * into v_e from event_bookings where id = p_event and property_id = current_property() for update;
  if v_e.id is null then raise exception 'EVENT_NOT_FOUND: that event no longer exists'; end if;
  if v_e.status in ('cancelled', 'completed') then
    raise exception 'EVENT_ROOMS_CLOSED: rooms can only be held for an event that is still to happen';
  end if;
  if exists (select 1 from booking_groups where event_id = p_event) then
    raise exception 'EVENT_ROOMS_HELD: this event already holds rooms; add more on its group page';
  end if;
  if jsonb_array_length(coalesce(p_rooms, '[]')) = 0 then
    raise exception 'EVENT_ROOMS_NONE: hold at least one room';
  end if;
  if coalesce(p_group->>'room_billing', 'guest') not in ('guest', 'organiser') then
    raise exception 'EVENT_ROOMS_BILLING: choose who pays for the rooms';
  end if;

  insert into booking_groups (name, company_id, rate_plan_id, organiser_name, organiser_phone, organiser_email,
                              check_in, check_out, notes, created_by, event_id, release_on, room_billing)
  values (v_e.title, v_e.company_id, nullif(p_group->>'rate_plan_id', '')::uuid,
          coalesce(v_e.contact_name, ''), coalesce(v_e.contact_phone, ''), coalesce(v_e.contact_email, ''),
          (p_group->>'check_in')::date, (p_group->>'check_out')::date,
          'Rooms for ' || v_e.number, auth.uid(), p_event,
          nullif(p_group->>'release_on', '')::date, coalesce(p_group->>'room_billing', 'guest'))
  returning id into v_group;

  insert into bookings (group_id, company_id, rate_plan_id, room_type_id, check_in, check_out,
                        adults, children, rooms_count, status, source, quoted_rate, total_amount,
                        rate_breakdown, deposit_required, hold_until, contact_name, contact_email,
                        contact_phone, created_by)
  select v_group, v_e.company_id, nullif(p_group->>'rate_plan_id', '')::uuid,
         (r->>'room_type_id')::uuid, (p_group->>'check_in')::date, (p_group->>'check_out')::date,
         coalesce((r->>'adults')::int, 2), 0, 1,
         case when v_e.status = 'confirmed' then 'confirmed' else 'tentative' end::booking_status,
         'email', (r->>'quoted_rate')::numeric, (r->>'total_amount')::numeric,
         coalesce(r->'rate_breakdown', '[]'::jsonb), 0, null,
         coalesce(r->>'contact_name', ''), '', '', auth.uid()
    from jsonb_array_elements(p_rooms) r;

  return v_group;
end;
$$;

/* The rooms follow the event: confirmed with it, released when it is cancelled. */
create or replace function event_rooms_follow_event()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = old.status then return new; end if;
  if new.status = 'confirmed' then
    update bookings b set status = 'confirmed', hold_until = null
      from booking_groups g
     where g.event_id = new.id and b.group_id = g.id and b.status = 'tentative';
  elsif new.status = 'cancelled' then
    update bookings b
       set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), hold_until = null,
           cancellation_reason = 'Event ' || new.number || ' cancelled'
      from booking_groups g
     where g.event_id = new.id and b.group_id = g.id and b.status in ('tentative', 'confirmed');
  end if;
  return new;
end;
$$;

drop trigger if exists event_bookings_rooms on event_bookings;
create trigger event_bookings_rooms
  after update of status on event_bookings
  for each row execute function event_rooms_follow_event();

/*
 * Releases an event's rooms nobody has taken: still unnamed, not yet
 * arrived. Run by night audit on the cut-off date, and from the event page.
 * Returns how many rooms went back on sale.
 */
create or replace function event_release_unsold_rooms(p_event uuid)
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  v_count int;
begin
  if not (has_permission('events.book') or has_permission('frontdesk.night_audit')) then
    raise exception 'not permitted';
  end if;
  update bookings b
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(), hold_until = null,
         cancellation_reason = 'Released unsold at the event''s cut-off'
    from booking_groups g
   where g.event_id = p_event and b.group_id = g.id
     and b.status in ('tentative', 'confirmed')
     and group_room_unnamed(b.id);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

/*
 * The folio an organiser-paid room's nights go on: one per stay, belonging to
 * the event, opened the first time it is needed. Null for a room the guest
 * pays for (or that is not an event room).
 */
create or replace function event_room_folio(p_booking uuid)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_event  uuid;
  v_number text;
  v_folio  uuid;
begin
  select g.event_id, e.number into v_event, v_number
    from bookings b
    join booking_groups g on g.id = b.group_id
    join event_bookings e on e.id = g.event_id
   where b.id = p_booking and g.room_billing = 'organiser' and e.status <> 'cancelled';
  if v_event is null then return null; end if;

  perform 1 from bookings where id = p_booking for update;
  select id into v_folio from folios where booking_id = p_booking and event_id = v_event limit 1;
  if v_folio is null then
    insert into folios (booking_id, kind, label, event_id, created_by)
    values (p_booking, 'split', 'Organiser — ' || v_number, v_event, auth.uid())
    returning id into v_folio;
  end if;
  return v_folio;
end;
$$;

/* What the event's organiser-paid rooms come to: their folios' charges with tax, less allowances. */
create or replace function event_rooms_total(p_event uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce(sum(case when e.kind in ('room', 'fee', 'penalty', 'extra') then e.amount + e.tax_amount
                                  when e.kind = 'adjustment' then -e.amount
                                  else 0 end), 0), 2)
    from folio_entries e
    join folios f on f.id = e.folio_id
   where f.event_id = p_event and e.voided_at is null;
$$;

/* As 0036, plus the organiser-paid rooms: the event's payments settle them too. */
create or replace function event_balance(p_event uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(
    coalesce((select e.grand_total from event_bookings e where e.id = p_event), 0)
    + event_rooms_total(p_event)
    - coalesce((select sum(case when p.kind = 'refund' then -p.amount else p.amount end)
                  from event_payments p
                 where p.event_id = p_event and p.voided_at is null), 0)
    - coalesce((select sum(c.grand_total) from credit_notes c where c.event_id = p_event), 0), 2);
$$;

/*
 * As 0039, plus: an organiser folio is invoiced once its event is, because
 * the event's invoice carries its room nights.
 */
create or replace function folio_is_invoiced(p_folio uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from invoices where folio_id = p_folio and status = 'issued')
      or exists (select 1 from folios f join invoices i on i.event_id = f.event_id and i.status = 'issued'
                  where f.id = p_folio and f.event_id is not null);
$$;

-- ── B. A till cannot sell more than the stock ───────────────────────────────

/*
 * What a till may still sell of each stock-tracked item at an outlet: on hand
 * at the outlet's location, less what its unsettled bills already hold (stock
 * is only taken when a bill settles). For the till's "n left" and "Sold out";
 * readable by anyone who can take orders there, without inventory rights.
 */
create or replace function pos_item_stock(p_outlet uuid)
returns table (pos_item_id uuid, available numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_location uuid;
begin
  if not (pos_may_order(p_outlet) or has_permission('inventory.view') or has_permission('inventory.manage')) then
    raise exception 'not permitted';
  end if;
  select id into v_location from inventory_locations where outlet_id = p_outlet and is_active;
  if v_location is null then return; end if;

  return query
  select ii.pos_item_id,
         round(coalesce((select sum(m.qty) from inventory_movements m
                          where m.item_id = ii.id and m.location_id = v_location), 0)
             - coalesce((select sum(l.qty) from pos_order_lines l
                           join pos_orders o on o.id = l.order_id
                          where l.item_id = ii.pos_item_id and l.voided_at is null
                            and o.outlet_id = p_outlet and o.status in ('open', 'billed')), 0), 3)
    from inventory_items ii
    join pos_items pi on pi.id = ii.pos_item_id and pi.outlet_id = p_outlet
   where ii.is_active;
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
  v_stock  uuid;
  v_left   numeric;
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

  -- 0042: a stock-tracked item cannot be sold beyond what the outlet holds.
  -- Housekeeping's minibar postings set bluinn.skip_stock_check: the guest
  -- has already had the items, so they are charged and the stock goes short.
  if coalesce(current_setting('bluinn.skip_stock_check', true), '') <> 'on' then
    select ii.id into v_stock from inventory_items ii where ii.pos_item_id = p_item and ii.is_active for update;
    if v_stock is not null then
      select s.available into v_left from pos_item_stock(v_item.outlet_id) s where s.pos_item_id = p_item;
      if v_left is not null and p_qty > v_left then
        raise exception 'INVENTORY_OUT: %',
          case when v_left <= 0 then v_item.name || ' is sold out at this outlet'
               else 'only ' || trim(to_char(v_left, 'FM999999990.###')) || ' ' || v_item.name || ' left at this outlet' end;
      end if;
    end if;
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

/* As 0032, but never refused for stock: what was used in the room is charged. */
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

  perform set_config('bluinn.skip_stock_check', 'on', true);
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    if coalesce((v_item ->> 'qty')::numeric, 0) > 0 then
      perform pos_add_line(v_order, (v_item ->> 'item_id')::uuid, (v_item ->> 'qty')::numeric, '{}', coalesce(p_notes, ''));
      v_lines := v_lines + 1;
    end if;
  end loop;
  perform set_config('bluinn.skip_stock_check', 'off', true);
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
