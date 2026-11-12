-- ============================================================================
-- Section 2 of docs/interconnection-audit-2026-11-07.md, "Data that doesn't
-- flow between modules": the database half. The app half is in the
-- housekeeping, maintenance, POS, event, billing, booking, HR and cron code.
-- Run after 0040_fix_first.sql. Each section names the finding it fixes.
-- ============================================================================

-- ── Rooms, housekeeping and maintenance ─────────────────────────────────────

/*
 * Takes a ticket's room out of order from today. Before 0041 any later stay
 * assigned to the room refused the block (ROOM_IN_USE for a booking three
 * days out), so an urgent fault could not be blocked. Now only a guest in the
 * room refuses it; later stays are unassigned, to be given another room.
 * Used by mt_block_room and by reopening a ticket that had blocked its room.
 */
create or replace function mt_apply_block(p_ticket uuid)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_t      maintenance_tickets;
  v_today  date := hk_business_today();
  v_guest  text;
  v_block  uuid;
begin
  select * into v_t from maintenance_tickets where id = p_ticket;
  if v_t.id is null or v_t.room_id is null then raise exception 'NO_ROOM' using errcode = 'P0001'; end if;

  select id into v_block from room_blocks where ticket_id = p_ticket and released_at is null limit 1;
  if v_block is not null then return v_block; end if;

  select string_agg(reference, ', ') into v_guest
    from bookings where room_id = v_t.room_id and status = 'checked_in';
  if v_guest is not null then
    raise exception 'ROOM_IN_USE: %', v_guest using errcode = 'P0001';
  end if;

  -- Later stays lose the room and go back to the desk's unassigned list.
  update bookings set room_id = null
   where room_id = v_t.room_id
     and status in ('tentative', 'confirmed')
     and check_out > v_today;

  insert into room_blocks (room_id, kind, start_date, reason, created_by, ticket_id)
  values (v_t.room_id, 'out_of_order', v_today, v_t.reference || ': ' || v_t.title, auth.uid(), p_ticket)
  returning id into v_block;

  update rooms set status = 'out_of_order' where id = v_t.room_id and status <> 'occupied';
  update maintenance_tickets set affects_room = true where id = p_ticket and not affects_room;
  return v_block;
end;
$$;

create or replace function mt_block_room(p_ticket uuid)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_status text;
begin
  if not has_permission('maintenance.report') then raise exception 'not permitted'; end if;
  select status into v_status from maintenance_tickets where id = p_ticket;
  if v_status in ('resolved', 'cancelled') then raise exception 'TICKET_CLOSED' using errcode = 'P0001'; end if;
  return mt_apply_block(p_ticket);
end;
$$;

/*
 * Blocks and tickets follow each other. Releasing a ticket's block from the
 * Rooms page means the room is fixed, so the ticket is resolved; reopening a
 * resolved ticket that had taken its room out of order takes it out again.
 */
create or replace function room_block_released_resolves_ticket()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.released_at is null and new.released_at is not null and new.ticket_id is not null then
    update maintenance_tickets
       set status = 'resolved', resolved_at = now(), resolved_by = coalesce(new.released_by, auth.uid()),
           resolution_note = case when resolution_note = '' then 'Room released: ' || coalesce(nullif(new.release_note, ''), 'back in service')
                                  else resolution_note end,
           updated_at = now()
     where id = new.ticket_id and status not in ('resolved', 'cancelled');
  end if;
  return new;
end;
$$;

drop trigger if exists room_blocks_resolve_ticket on room_blocks;
create trigger room_blocks_resolve_ticket
  after update of released_at on room_blocks
  for each row execute function room_block_released_resolves_ticket();

create or replace function ticket_reopened_reblocks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('resolved', 'cancelled') and new.status in ('open', 'in_progress', 'on_hold')
     and new.affects_room and new.room_id is not null
     and not exists (select 1 from bookings where room_id = new.room_id and status = 'checked_in') then
    perform mt_apply_block(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists maintenance_tickets_reblock on maintenance_tickets;
create trigger maintenance_tickets_reblock
  after update of status on maintenance_tickets
  for each row execute function ticket_reopened_reblocks();

/* A room taken out of order or out of service is not cleaned: its open tasks are cancelled. */
create or replace function room_off_sale_cancels_tasks()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('out_of_order', 'out_of_service') and old.status not in ('out_of_order', 'out_of_service') then
    update housekeeping_tasks
       set status = 'cancelled',
           notes = trim(both ' ' from notes || ' (room taken ' || replace(new.status::text, '_', ' ') || ')')
     where room_id = new.id and status in ('pending', 'in_progress');
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_off_sale_cancels_tasks on rooms;
create trigger rooms_off_sale_cancels_tasks
  after update of status on rooms
  for each row execute function room_off_sale_cancels_tasks();

-- Daily stay-over cleaning on by default for a new hotel (existing hotels keep
-- whatever they chose; Settings → Housekeeping turns it on).
alter table properties alter column hk_stayover_enabled set default true;

-- ── Folio, POS and events ───────────────────────────────────────────────────

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
  -- 0041: a bill from one hotel is never charged to a stay at another.
  if v_booking.property_id is distinct from v_order.property_id then
    raise exception 'POS_OTHER_PROPERTY: that guest is staying at another hotel; take payment at the outlet instead';
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
  -- 0040: a stay already invoiced takes new charges on its "After invoice"
  -- folio (0039). Choose it here, before anything is posted, so the charges,
  -- the "already paid" credit and the payment record all land together.
  if folio_is_invoiced(v_folio) then
    v_folio := after_invoice_folio(p_booking);
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

create or replace function event_post_to_folio(p_event uuid, p_booking uuid, p_folio uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_e       record;
  v_booking record;
  v_folio   uuid := p_folio;
  v_company uuid;
  v_owing   numeric(12,2);
  v_band    record;
  v_label   text;
  v_payment uuid;
  v_staff   uuid := auth.uid();
begin
  if not has_permission('events.bill') then
    raise exception 'not permitted';
  end if;

  select * into v_e from event_bookings where id = p_event;
  if v_e is null then
    raise exception 'EVENT_NOT_FOUND' using hint = 'That event no longer exists.';
  end if;
  if v_e.status not in ('confirmed', 'completed') then
    raise exception 'EVENT_NOT_CONFIRMED'
      using hint = 'Confirm the event before billing it.';
  end if;
  if exists (select 1 from invoices where event_id = p_event and status = 'issued') then
    raise exception 'EVENT_INVOICED'
      using hint = 'This event already has its own invoice. Cancel it before billing the event to a room.';
  end if;

  v_owing := event_balance(p_event);
  if v_owing <= 0 then
    raise exception 'EVENT_NOTHING_OWED' using hint = 'This event is already settled.';
  end if;

  select b.*, g.full_name as guest_full_name
    into v_booking
    from bookings b left join guests g on g.id = b.guest_id
   where b.id = p_booking;
  if v_booking is null then
    raise exception 'EVENT_NO_BOOKING' using hint = 'Choose the stay to bill this event to.';
  end if;
  -- 0041: only a guest still in house. A stay that has checked out is
  -- invoiced and closed; bill the event on its own invoice instead.
  if v_booking.status <> 'checked_in' then
    raise exception 'EVENT_BOOKING_NOT_RESIDENT'
      using hint = 'An event can only be billed to a guest who is in house. Invoice it on its own instead.';
  end if;
  if v_booking.property_id is distinct from v_e.property_id then
    raise exception 'EVENT_OTHER_PROPERTY: that guest is staying at another hotel';
  end if;

  if v_folio is null then
    v_folio := master_folio(p_booking);
  end if;
  if not exists (select 1 from folios where id = v_folio and booking_id = p_booking) then
    raise exception 'FOLIO_BOOKING_MISMATCH' using hint = 'That folio belongs to a different booking.';
  end if;
  -- 0040: as for outlet bills, an invoiced stay takes the event on its
  -- "After invoice" folio, with the deposit credit and the transfer record.
  if folio_is_invoiced(v_folio) then
    v_folio := after_invoice_folio(p_booking);
  end if;

  -- A folio billed to a company is the company's debt, so its limit applies.
  select company_id into v_company from folios where id = v_folio;
  if v_company is not null then
    if exists (
      select 1 from companies
       where id = v_company and credit_limit is not null
         and company_balance(v_company) + v_owing > credit_limit
    ) then
      raise exception 'CITY_LEDGER_CREDIT_LIMIT: this event of % would take the company past its credit limit',
        v_owing;
    end if;
  end if;

  v_label := v_e.title || ' — ' || v_e.number;

  for v_band in select * from event_tax_bands(p_event) loop
    insert into folio_entries (booking_id, folio_id, kind, description, stay_date,
                               amount, tax_amount, tax_rate, reference, created_by)
    values (p_booking, v_folio, 'extra', v_label, v_e.event_date,
            v_band.net, v_band.tax, v_band.rate, v_e.number, v_staff);
  end loop;

  -- Anything already paid directly to the event is credited back on the folio,
  -- so the guest is not asked for it twice.
  if v_e.grand_total - v_owing > 0 then
    insert into folio_entries (booking_id, folio_id, kind, description, stay_date,
                               amount, tax_amount, tax_rate, reference, created_by)
    values (p_booking, v_folio, 'adjustment', v_label || ' — deposit already paid', v_e.event_date,
            round(v_e.grand_total - v_owing, 2), 0, 0, v_e.number, v_staff);
  end if;

  insert into event_payments (event_id, kind, amount, booking_id, folio_id, reference, created_by)
  values (p_event, 'room_charge', v_owing, p_booking, v_folio, coalesce(v_booking.reference, ''), v_staff)
  returning id into v_payment;

  update event_bookings
     set booking_id = coalesce(booking_id, p_booking), updated_at = now()
   where id = p_event;

  return v_payment;
end;
$$;

/*
 * Float + rupee cash taken − rupee cash refunded (folios, outlets and events,
 * voids excluded) + pay-ins − paid-outs − safe drops. Cash taken in another
 * currency (fx_currency set) is not rupees in the drawer, so it is left out
 * here and shown per currency by shiftBreakdown() in app/lib/cashier.ts (0041).
 */
create or replace function cashier_shift_expected(p_shift uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(
    coalesce((select opening_float from cashier_shifts where id = p_shift), 0)
    + coalesce((select sum(case when kind = 'payment' then amount else -amount end)
                  from folio_entries
                 where shift_id = p_shift and method = 'cash' and kind in ('payment', 'refund')
                   and fx_currency is null and voided_at is null), 0)
    + coalesce((select sum(amount) from pos_payments
                 where shift_id = p_shift and kind = 'cash' and voided_at is null), 0)
    + coalesce((select sum(case when kind = 'refund' then -amount else amount end)
                  from event_payments
                 where shift_id = p_shift and method = 'cash' and kind in ('advance', 'payment', 'refund')
                   and voided_at is null), 0)
    + coalesce((select sum(case when kind = 'pay_in' then amount else -amount end)
                  from cash_movements where shift_id = p_shift), 0),
  2);
$$;

/*
 * Voiding an outlet bill's or an event's lines on the guest's folio undoes the
 * transfer: once none of its charges are left, the "already paid" credit is
 * voided too, the room-charge record is voided and an outlet bill is open
 * again at the outlet, so outlet sales and the room-charge limit agree with
 * the folio. (A correction by credit note leaves the sale standing: it was
 * made, and the invoice is what is corrected.)
 */
create or replace function folio_void_undoes_transfer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_order record;
  v_event record;
begin
  if not (old.voided_at is null and new.voided_at is not null and coalesce(new.reference, '') <> '') then
    return new;
  end if;
  if exists (select 1 from folio_entries
              where booking_id = new.booking_id and reference = new.reference
                and kind = 'extra' and voided_at is null) then
    return new;
  end if;

  update folio_entries
     set voided_at = new.voided_at, voided_by = new.voided_by,
         void_reason = 'Charges voided: ' || new.void_reason
   where booking_id = new.booking_id and reference = new.reference
     and kind = 'adjustment' and voided_at is null;

  for v_order in
    select o.id from pos_orders o
     where o.number = new.reference and o.property_id = new.property_id
       and exists (select 1 from pos_payments p where p.order_id = o.id and p.kind = 'room_charge'
                     and p.booking_id = new.booking_id and p.voided_at is null)
  loop
    update pos_payments
       set voided_at = now(), voided_by = auth.uid(), void_reason = 'Voided on the folio: ' || new.void_reason
     where order_id = v_order.id and kind = 'room_charge' and booking_id = new.booking_id and voided_at is null;
    update pos_orders set status = 'open', closed_at = null where id = v_order.id and status = 'settled';
  end loop;

  for v_event in
    select e.id from event_bookings e where e.number = new.reference and e.property_id = new.property_id
  loop
    update event_payments
       set voided_at = now(), voided_by = auth.uid(), void_reason = 'Voided on the folio: ' || new.void_reason
     where event_id = v_event.id and kind = 'room_charge' and booking_id = new.booking_id and voided_at is null;
  end loop;
  return new;
end;
$$;

drop trigger if exists folio_entries_undo_transfer on folio_entries;
create trigger folio_entries_undo_transfer
  after update of voided_at on folio_entries
  for each row execute function folio_void_undoes_transfer();

/* An event already on a guest's folio is invoiced there, never on its own as well. */
create or replace function invoice_event_not_on_folio()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.event_id is not null and exists (
       select 1 from event_payments
        where event_id = new.event_id and kind = 'room_charge' and voided_at is null) then
    raise exception 'EVENT_ON_FOLIO: this event is billed to a guest''s room; it is invoiced on their folio';
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_event_not_on_folio on invoices;
create trigger invoices_event_not_on_folio
  before insert on invoices
  for each row execute function invoice_event_not_on_folio();

-- ── Stock ───────────────────────────────────────────────────────────────────

/*
 * A bill's stock follows the bill: settling it takes what it sold (the
 * difference against what it already took, 0039), and voiding it puts back
 * whatever it had taken (0041) — a bill settled, reopened and then voided as
 * never sold used to keep its stock off the shelf.
 */
create or replace function inventory_consume_pos()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_location uuid;
  v_void     boolean := new.status = 'void' and old.status <> 'void';
begin
  if not v_void and (new.status <> 'settled' or old.status = 'settled') then return new; end if;
  select id into v_location from inventory_locations where outlet_id = new.outlet_id and is_active;
  if v_location is null then return new; end if;

  insert into inventory_movements (property_id, item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
  select new.property_id, x.item_id, v_location,
         case when x.delta > 0 then 'consume' else 'adjust' end,
         -x.delta, x.unit_cost,
         case when x.delta > 0 then 'Sold' when v_void then 'Bill voided' else 'Returned from bill' end,
         new.number, auth.uid()
    from (
      select ii.id as item_id, ii.unit_cost,
             case when v_void then 0 else coalesce(sold.qty, 0) end - coalesce(taken.qty, 0) as delta
        from inventory_items ii
        left join (select l.item_id, sum(l.qty) as qty
                     from pos_order_lines l
                    where l.order_id = new.id and l.voided_at is null
                    group by l.item_id) sold on sold.item_id = ii.pos_item_id
        left join (select m.item_id, -sum(m.qty) as qty
                     from inventory_movements m
                    where m.reference = new.number and m.location_id = v_location
                      and m.kind in ('consume', 'adjust')
                    group by m.item_id) taken on taken.item_id = ii.id
       where ii.pos_item_id is not null and ii.is_active
         and (sold.qty is not null or taken.qty is not null)
    ) x
   where x.delta <> 0;
  return new;
end;
$$;

-- ── Guests and loyalty ──────────────────────────────────────────────────────

create or replace function merge_guests(p_keep uuid, p_drop uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  k guests;
  d guests;
  v_tier text;
begin
  if not has_permission('guests.privacy') then raise exception 'not permitted'; end if;
  if p_keep = p_drop then raise exception 'SAME_GUEST' using errcode = 'P0001'; end if;
  select * into k from guests where id = p_keep for update;
  select * into d from guests where id = p_drop for update;
  if k.id is null or d.id is null then raise exception 'GUEST_NOT_FOUND' using errcode = 'P0001'; end if;
  -- 0041: an erased profile stays erased. Merging into it copied the other
  -- guest's personal data back onto a record the guest asked to be forgotten.
  if k.erased_at is not null then
    raise exception 'GUEST_ERASED: that profile was erased at the guest''s request; keep the other one instead';
  end if;

  update bookings        set guest_id = p_keep where guest_id = p_drop;
  update guest_documents set guest_id = p_keep where guest_id = p_drop;
  update guest_feedback  set guest_id = p_keep where guest_id = p_drop;
  if exists (select 1 from guest_identities where guest_id = p_keep) then
    delete from guest_identities where guest_id = p_drop;
  else
    update guest_identities set guest_id = p_keep where guest_id = p_drop;
  end if;

  -- Stays the dropped guest shared or was primary on (0030). The bookings
  -- update above has already added the kept guest as primary where the
  -- dropped one was the booker.
  insert into booking_guests (booking_id, guest_id, property_id, is_primary, added_by, added_at)
  select bg.booking_id, p_keep, bg.property_id, bg.is_primary, bg.added_by, bg.added_at
    from booking_guests bg where bg.guest_id = p_drop
  on conflict (booking_id, guest_id) do update
    set is_primary = booking_guests.is_primary or excluded.is_primary;
  delete from booking_guests where guest_id = p_drop;

  -- Loyalty (0016), events (0019), promotions (0020), messages (0022).
  update loyalty_transactions set guest_id = p_keep where guest_id = p_drop;
  update loyalty_tier_history set guest_id = p_keep where guest_id = p_drop;
  update event_bookings       set guest_id = p_keep where guest_id = p_drop;
  update promo_redemptions    set guest_id = p_keep where guest_id = p_drop;
  update notifications        set guest_id = p_keep where guest_id = p_drop;

  -- The better of the two tiers, by the programme's own order.
  select t.key into v_tier
    from loyalty_tiers t
   where t.key in (k.loyalty_tier, d.loyalty_tier)
   order by t.sort_order desc
   limit 1;

  -- The membership number is unique, so free it before the kept guest takes it.
  update guests set loyalty_member_no = null where id = p_drop;

  update guests set
    email                  = coalesce(nullif(k.email, ''), d.email),
    phone                  = coalesce(nullif(k.phone, ''), d.phone),
    address                = coalesce(nullif(k.address, ''), d.address),
    city                   = coalesce(nullif(k.city, ''), d.city),
    date_of_birth          = coalesce(k.date_of_birth, d.date_of_birth),
    anniversary            = coalesce(k.anniversary, d.anniversary),
    company_id             = coalesce(k.company_id, d.company_id),
    preferred_room_type_id = coalesce(k.preferred_room_type_id, d.preferred_room_type_id),
    preferred_floor        = coalesce(k.preferred_floor, d.preferred_floor),
    dietary                = concat_ws('; ', nullif(k.dietary, ''), nullif(d.dietary, '')),
    preferences            = concat_ws('; ', nullif(k.preferences, ''), nullif(d.preferences, '')),
    notes                  = concat_ws(E'\n', nullif(k.notes, ''), nullif(d.notes, '')),
    blacklist_reason       = concat_ws('; ', nullif(k.blacklist_reason, ''), nullif(d.blacklist_reason, '')),
    tags                   = array(select distinct unnest(k.tags || d.tags)),
    marketing_opt_in       = k.marketing_opt_in or d.marketing_opt_in,
    loyalty_opt_in         = coalesce(k.loyalty_opt_in, false) or coalesce(d.loyalty_opt_in, false),
    loyalty_member_no      = coalesce(k.loyalty_member_no, d.loyalty_member_no),
    loyalty_joined_on      = least(k.loyalty_joined_on, d.loyalty_joined_on),
    loyalty_tier           = coalesce(v_tier, k.loyalty_tier, d.loyalty_tier),
    updated_at             = now()
  where id = p_keep;

  delete from guests where id = p_drop;
  perform log_event('guests', 'merge', p_keep::text,
                    format('Merged %s into %s', d.full_name, k.full_name));
end;
$$;

/*
 * Points follow the invoice that earned them. Cancelling the invoice takes
 * them all back; a credit note takes back its share. Before 0041 a cancelled
 * and re-issued invoice earned twice, and credit notes reduced nothing.
 * Recorded as 'adjust' rows against the invoice, and taken out of the earning
 * lot first so they cannot be spent afterwards.
 */
create or replace function loyalty_reverse_for_invoice(p_invoice uuid, p_points int, p_reason text)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_earn  loyalty_transactions;
  v_taken int;
  v_take  int;
begin
  select * into v_earn from loyalty_transactions where invoice_id = p_invoice and kind = 'earn' limit 1;
  if v_earn.id is null then return 0; end if;
  select coalesce(-sum(points), 0) into v_taken
    from loyalty_transactions where invoice_id = p_invoice and kind = 'adjust' and points < 0;
  v_take := least(p_points, v_earn.points - v_taken);
  if v_take <= 0 then return 0; end if;

  update loyalty_transactions set remaining = greatest(remaining - v_take, 0) where id = v_earn.id;
  insert into loyalty_transactions (guest_id, kind, points, remaining, booking_id, invoice_id, description, created_by, property_id)
  values (v_earn.guest_id, 'adjust', -v_take, 0, v_earn.booking_id, p_invoice, p_reason, auth.uid(), v_earn.property_id);
  return v_take;
end;
$$;

create or replace function loyalty_invoice_cancelled()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'issued' and new.status = 'cancelled' then
    perform loyalty_reverse_for_invoice(new.id, 2147483647, 'Invoice ' || new.number || ' cancelled');
  end if;
  return new;
end;
$$;

drop trigger if exists invoices_loyalty_reverse on invoices;
create trigger invoices_loyalty_reverse
  after update of status on invoices
  for each row execute function loyalty_invoice_cancelled();

create or replace function loyalty_credit_note()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_inv   invoices;
  v_earn  int;
begin
  if new.invoice_id is null then return new; end if;
  select * into v_inv from invoices where id = new.invoice_id;
  if v_inv.id is null or coalesce(v_inv.net_total, 0) <= 0 then return new; end if;
  select points into v_earn from loyalty_transactions where invoice_id = new.invoice_id and kind = 'earn' limit 1;
  if v_earn is null then return new; end if;
  perform loyalty_reverse_for_invoice(
    new.invoice_id,
    floor(v_earn * least(new.net_total / v_inv.net_total, 1))::int,
    'Credit note ' || new.number || ' against ' || v_inv.number);
  return new;
end;
$$;

drop trigger if exists credit_notes_loyalty on credit_notes;
create trigger credit_notes_loyalty
  after insert on credit_notes
  for each row execute function loyalty_credit_note();

-- Points at check-out no longer depend on who checks the guest out: whoever
-- may check a guest out may issue the invoice that goes with it (and the
-- points it earns). The app issues it at check-out for frontdesk.checkout.
drop policy if exists invoices_insert on invoices;
create policy invoices_insert on invoices for insert
  with check (has_permission('folio.invoice') or has_permission('frontdesk.checkout'));

/*
 * Exchange rates are the group's, shared by every hotel (currencies has no
 * property). One hotel's manager changing them changed every hotel's, so only
 * head office (all properties) or a superuser may.
 */
drop policy if exists currencies_write on currencies;
create policy currencies_write on currencies for all
  using ((has_permission('settings.manage') or has_permission('folio.city_ledger'))
         and exists (select 1 from staff s join roles r on r.key = s.role
                      where s.id = auth.uid() and (s.all_properties or r.is_superuser)))
  with check ((has_permission('settings.manage') or has_permission('folio.city_ledger'))
         and exists (select 1 from staff s join roles r on r.key = s.role
                      where s.id = auth.uid() and (s.all_properties or r.is_superuser)));

-- ── People ──────────────────────────────────────────────────────────────────

create or replace function attendance_device_event(p_code text, p_event text, p_at timestamptz default now())
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  v_staff    uuid;
  v_property uuid;
  v_tz       text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then raise exception 'not permitted'; end if;
  select id, property_id into v_staff, v_property from staff where lower(employee_code) = lower(trim(p_code)) and is_active;
  if v_staff is null then return 'unknown_employee'; end if;
  -- 0041: the punch is filed at the person's own hotel, on its calendar.
  -- It used to go to the default hotel, in that hotel's time zone.
  select timezone into v_tz from properties where id = v_property;

  if p_event = 'in' then
    if exists (select 1 from attendance where staff_id = v_staff and clock_out is null) then
      return 'already_in';
    end if;
    insert into attendance (staff_id, work_date, clock_in, method, property_id)
    values (v_staff, (p_at at time zone coalesce(nullif(v_tz, ''), 'Asia/Kolkata'))::date,
            p_at, 'biometric', v_property);
    return 'clocked_in';
  elsif p_event = 'out' then
    update attendance set clock_out = p_at
     where staff_id = v_staff and clock_out is null and clock_in < p_at;
    return case when found then 'clocked_out' else 'not_in' end;
  end if;
  return 'bad_event';
end;
$$;

/*
 * Someone's attendance, leave and timesheets belong to the hotel they work
 * at, whichever hotel they happen to be looking at when they clock in or ask
 * for leave. Their own records stay visible to them from any hotel.
 */
create or replace function hr_record_home_property()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_home uuid;
begin
  select property_id into v_home from staff where id = new.staff_id;
  if v_home is not null then
    new.property_id := v_home;
  end if;
  return new;
end;
$$;

drop trigger if exists attendance_home_property on attendance;
create trigger attendance_home_property before insert on attendance
  for each row execute function hr_record_home_property();
drop trigger if exists leave_requests_home_property on leave_requests;
create trigger leave_requests_home_property before insert on leave_requests
  for each row execute function hr_record_home_property();
drop trigger if exists timesheets_home_property on timesheets;
create trigger timesheets_home_property before insert on timesheets
  for each row execute function hr_record_home_property();

drop policy if exists attendance_property on attendance;
create policy attendance_property on attendance as restrictive for all
  using (can_access_property(property_id) or staff_id = auth.uid())
  with check (can_access_property(property_id) or staff_id = auth.uid());
drop policy if exists leave_requests_property on leave_requests;
create policy leave_requests_property on leave_requests as restrictive for all
  using (can_access_property(property_id) or staff_id = auth.uid())
  with check (can_access_property(property_id) or staff_id = auth.uid());
drop policy if exists timesheets_property on timesheets;
create policy timesheets_property on timesheets as restrictive for all
  using (can_access_property(property_id) or staff_id = auth.uid())
  with check (can_access_property(property_id) or staff_id = auth.uid());

-- The payroll export (hr.export) reads the roster like attendance and leave;
-- without this it showed 0 rostered shifts and 0 absences for everyone.
drop policy if exists staff_shifts_select on staff_shifts;
create policy staff_shifts_select on staff_shifts for select
  using (staff_id = auth.uid() or has_permission('hr.view') or has_permission('hr.manage') or has_permission('hr.export'));

/*
 * Moving a staff member to another of the caller's hotels. The row's new hotel
 * is not the one the caller is working in, so row security refused the plain
 * update ("Moving staff between hotels errors out"). This checks what the
 * policy cannot: the caller may manage staff and has access to both hotels.
 * The person's own switcher goes back to their new home hotel.
 */
create or replace function staff_move_property(p_staff uuid, p_property uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_from uuid;
begin
  if not has_permission('staff.manage') then raise exception 'not permitted'; end if;
  select property_id into v_from from staff where id = p_staff;
  if not found then raise exception 'STAFF_NOT_FOUND: that staff member no longer exists'; end if;
  if v_from is not null and v_from not in (select staff_property_ids()) then
    raise exception 'PROPERTY_NOT_YOURS: they work at a hotel you do not have access to';
  end if;
  if p_property is null or p_property not in (select staff_property_ids())
     or not exists (select 1 from properties where id = p_property and is_active) then
    raise exception 'PROPERTY_NOT_YOURS: choose one of your hotels';
  end if;
  update staff set property_id = p_property, active_property_id = null where id = p_staff;
end;
$$;

-- ── Scheduled jobs work one hotel at a time ─────────────────────────────────

/*
 * As 0040, plus: a service-role request (a nightly job) may name the hotel it
 * is working for in its claims ({"property": "<id>"}), so the notification
 * and report jobs use each hotel's own settings, templates and figures. They
 * used to use the default hotel's for every hotel. Staff are unaffected.
 */
create or replace function current_property()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.id from properties p
      where coalesce(auth.role(), '') = 'service_role'
        and p.id::text = nullif(auth.jwt() ->> 'property', '')),
    (select case
              when s.active_property_id is null or s.active_property_id = s.property_id then s.property_id
              when s.all_properties then s.active_property_id
              when exists (select 1 from staff_properties sp
                            where sp.staff_id = s.id and sp.property_id = s.active_property_id)
                then s.active_property_id
              else s.property_id
            end
       from staff s where s.id = auth.uid()),
    (select p.id from properties p where p.is_default and p.is_active limit 1),
    (select p.id from properties p where p.is_active order by p.sort_order, p.name limit 1)
  );
$$;

/*
 * On Neon, trusted server work runs as the connecting (owner) role with
 * "service_role" in its claims (app/lib/neon/db.ts), not as a service_role
 * database role as on Supabase. Checking only the database role refused every
 * nightly job that a function lets in "or as the service role": the pricing
 * job's forecast and the scheduled reports' figures. The claims are set by
 * the server from a verified session, never by the browser.
 */
create or replace function is_service_role()
returns boolean language sql stable as $$
  select coalesce(current_setting('role', true), '') = 'service_role'
      or coalesce(auth.role(), '') = 'service_role';
$$;
