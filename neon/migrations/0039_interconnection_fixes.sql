-- ============================================================================
-- Interconnection fixes (docs: the Nov 2026 audit, "Fix these first")
--
--   1. An invoiced folio is closed to new charges and voids. Charges posted
--      afterwards — POS room charges, events, minibar, night audit, manual —
--      go to an "After invoice" folio of the same stay, which is invoiced on
--      its own. A correction to an invoiced line is a credit note.
--   2. A day closed by night audit stays closed: lines dated into it move to
--      the open business date (room nights keep their own night), and an
--      outlet bill settled on a closed day cannot be reopened.
--   3. merge_guests carries room sharers, loyalty, events, promotions and
--      notifications across, so it works for guests who have stayed.
--   5. A refund never exceeds what was paid, on a folio or on an event, and a
--      refund request cannot ask for more than is left to refund.
--   7. Automatic stock consumption is recorded once per bill and per clean,
--      however often the bill is reopened or the room re-cleaned; a manual
--      movement cannot take out more than is on hand.
--   8. A room returning from out of order / out of service is dirty and gets
--      a touch-up task, whichever screen or job released it.
--
-- Run after 0038_people_admin.sql.
-- ============================================================================

-- ── 1. Invoiced folios ───────────────────────────────────────────────────────

create index if not exists invoices_folio_issued_idx on invoices (folio_id) where status = 'issued';

create or replace function folio_is_invoiced(p_folio uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from invoices where folio_id = p_folio and status = 'issued');
$$;

/* The stay's open "After invoice" folio, opened the first time it is needed. */
create or replace function after_invoice_folio(p_booking uuid)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
begin
  -- One at a time per stay, so two late charges cannot open two folios.
  perform 1 from bookings where id = p_booking for update;
  select f.id into v_id
    from folios f
   where f.booking_id = p_booking and f.kind = 'split' and f.label = 'After invoice'
     and not folio_is_invoiced(f.id)
   order by f.created_at desc
   limit 1;
  if v_id is null then
    insert into folios (booking_id, kind, label, created_by)
    values (p_booking, 'split', 'After invoice', auth.uid())
    returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function folio_entry_invoiced_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_charge_folio uuid;
begin
  if tg_op = 'INSERT' then
    if new.kind = 'adjustment' then
      -- A credit note is how an invoiced folio is corrected; it posts its own line.
      if new.credit_note_id is not null then
        return new;
      end if;
      if new.applies_to is not null then
        select folio_id into v_charge_folio from folio_entries where id = new.applies_to;
        if folio_is_invoiced(v_charge_folio) then
          raise exception 'FOLIO_INVOICED: that charge is on an issued invoice; issue a credit note instead';
        end if;
        -- An allowance sits on the same folio as the charge it reduces.
        new.folio_id := v_charge_folio;
      elsif folio_is_invoiced(new.folio_id) then
        raise exception 'FOLIO_INVOICED: this folio has an issued invoice; issue a credit note instead';
      end if;
    elsif new.kind in ('room', 'fee', 'penalty', 'extra') and folio_is_invoiced(new.folio_id) then
      new.folio_id := after_invoice_folio(new.booking_id);
    end if;
    return new;
  end if;

  -- UPDATE
  if old.voided_at is null and new.voided_at is not null and folio_is_invoiced(old.folio_id) then
    raise exception 'FOLIO_INVOICED: this line is on an issued invoice; issue a credit note instead of voiding it';
  end if;
  if new.folio_id is distinct from old.folio_id
     and old.kind in ('room', 'fee', 'penalty', 'extra', 'adjustment')
     and (folio_is_invoiced(old.folio_id) or folio_is_invoiced(new.folio_id)) then
    raise exception 'FOLIO_INVOICED: lines cannot move onto or off an invoiced folio';
  end if;
  return new;
end;
$$;

-- Named to run after folio_entries_default_folio and _inherit_property, and
-- before folio_entries_tax_class reads applies_to.
drop trigger if exists folio_entries_invoiced on folio_entries;
create trigger folio_entries_invoiced
  before insert or update of voided_at, folio_id on folio_entries
  for each row execute function folio_entry_invoiced_guard();

-- ── 2. Closed days ───────────────────────────────────────────────────────────

create or replace function day_is_closed(p_property uuid, p_day date)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from night_audits
                  where property_id = p_property and business_date = p_day and status = 'completed');
$$;

/*
 * A charge, fee or payment dated into a closed day is a late posting: it
 * belongs to the open business date, as at every PMS. A room night keeps its
 * own night — the unique night index and the stay's nights depend on it — and
 * is stamped by the next audit as before.
 */
create or replace function folio_entry_late_posting()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_property uuid := coalesce(new.property_id, current_property());
begin
  if new.kind <> 'room' and new.stay_date is not null and day_is_closed(v_property, new.stay_date) then
    new.stay_date := (select business_date from properties where id = v_property);
  end if;
  return new;
end;
$$;

drop trigger if exists folio_entries_late_posting on folio_entries;
create trigger folio_entries_late_posting before insert on folio_entries
  for each row execute function folio_entry_late_posting();

/* A bill settled on a closed day is part of that day's takings. */
create or replace function pos_order_closed_day_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status = 'settled' and new.status <> 'settled' and old.closed_at is not null
     and day_is_closed(old.property_id, local_day(old.closed_at)) then
    raise exception 'POS_DAY_CLOSED: this bill was settled on %, which night audit has closed; refund or adjust it today instead',
      local_day(old.closed_at);
  end if;
  return new;
end;
$$;

drop trigger if exists pos_orders_closed_day on pos_orders;
create trigger pos_orders_closed_day before update of status on pos_orders
  for each row execute function pos_order_closed_day_guard();

create or replace function pos_payment_closed_day_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_order record;
begin
  if old.voided_at is null and new.voided_at is not null then
    select status, closed_at, property_id into v_order from pos_orders where id = old.order_id;
    if v_order.status = 'settled' and v_order.closed_at is not null
       and day_is_closed(v_order.property_id, local_day(v_order.closed_at)) then
      raise exception 'POS_DAY_CLOSED: this bill was settled on %, which night audit has closed; refund or adjust it today instead',
        local_day(v_order.closed_at);
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists pos_payments_closed_day on pos_payments;
create trigger pos_payments_closed_day before update of voided_at on pos_payments
  for each row execute function pos_payment_closed_day_guard();

-- ── 3. Merging guests ────────────────────────────────────────────────────────

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

-- ── 5. Refunds ───────────────────────────────────────────────────────────────

/*
 * What can still go back to the guest on a stay: money received less money
 * already refunded. Loyalty points are not money and are not refunded as such.
 */
create or replace function refundable_amount(p_booking uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(coalesce(sum(case
           when kind = 'payment' and coalesce(method::text, '') <> 'loyalty_points' then amount
           when kind = 'refund' then -amount
           else 0 end), 0), 2)
    from folio_entries
   where booking_id = p_booking and voided_at is null;
$$;

create or replace function folio_entry_refund_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_left numeric;
begin
  if new.kind <> 'refund' then return new; end if;
  -- Refunds on one stay are checked one at a time.
  perform 1 from bookings where id = new.booking_id for update;
  v_left := refundable_amount(new.booking_id);
  if new.amount > v_left + 0.005 then
    raise exception 'REFUND_EXCEEDS_PAID: only % has been paid and not yet refunded', greatest(v_left, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists folio_entries_refund_cap on folio_entries;
create trigger folio_entries_refund_cap before insert on folio_entries
  for each row execute function folio_entry_refund_cap();

/* A request may not ask for more than is left once other open requests are paid. */
create or replace function refund_request_cap()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_left numeric;
begin
  perform 1 from bookings where id = new.booking_id for update;
  v_left := refundable_amount(new.booking_id)
            - coalesce((select sum(amount) from refund_requests
                         where booking_id = new.booking_id and status in ('pending', 'approved')
                           and id <> new.id), 0);
  if new.amount > v_left + 0.005 then
    raise exception 'REFUND_EXCEEDS_PAID: only % is left to refund on this stay', greatest(round(v_left, 2), 0);
  end if;
  return new;
end;
$$;

drop trigger if exists refund_requests_cap on refund_requests;
create trigger refund_requests_cap before insert on refund_requests
  for each row execute function refund_request_cap();

create or replace function event_take_payment(
  p_event uuid, p_kind text, p_method payment_method, p_amount numeric,
  p_reference text default '', p_notes text default ''
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_owing numeric(12,2);
  v_paid  numeric(12,2);
  v_id    uuid;
begin
  if not has_permission('events.bill') then
    raise exception 'not permitted';
  end if;
  if p_kind not in ('advance', 'payment', 'refund') then
    raise exception 'EVENT_PAYMENT_KIND' using hint = 'Choose a deposit, a payment or a refund.';
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'EVENT_PAYMENT_AMOUNT' using hint = 'Enter an amount greater than zero.';
  end if;
  -- Locks the event so two payments or refunds are checked one at a time.
  perform 1 from event_bookings where id = p_event for update;
  if not found then
    raise exception 'EVENT_NOT_FOUND' using hint = 'That event no longer exists.';
  end if;
  if exists (select 1 from event_bookings where id = p_event and status = 'cancelled')
     and p_kind <> 'refund' then
    raise exception 'EVENT_CANCELLED'
      using hint = 'This event is cancelled. Only a refund can be recorded against it.';
  end if;

  if p_kind = 'refund' then
    select coalesce(sum(case when kind in ('advance', 'payment') then amount
                             when kind = 'refund' then -amount else 0 end), 0)
      into v_paid
      from event_payments
     where event_id = p_event and voided_at is null;
    if p_amount > v_paid + 0.005 then
      raise exception 'EVENT_REFUND_EXCEEDS_PAID: only % has been paid and not yet refunded', greatest(v_paid, 0);
    end if;
  else
    v_owing := event_balance(p_event);
    if p_amount > v_owing then
      raise exception 'EVENT_OVERPAYMENT: % is owed but % was entered', v_owing, p_amount;
    end if;
  end if;

  insert into event_payments (event_id, kind, amount, method, reference, notes, created_by)
  values (p_event, p_kind, round(p_amount, 2), p_method, coalesce(p_reference, ''), coalesce(p_notes, ''), auth.uid())
  returning id into v_id;

  return v_id;
end;
$$;

-- ── 7. Stock ─────────────────────────────────────────────────────────────────

/*
 * An outlet bill settled: its linked items leave the outlet's location. The
 * bill number is the reference, and only the difference from what that bill
 * has already taken is moved — so a bill reopened and settled again consumes
 * nothing twice, and a line voided in between goes back to stock.
 */
create or replace function inventory_consume_pos()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_location uuid;
begin
  if new.status <> 'settled' or old.status = 'settled' then return new; end if;
  select id into v_location from inventory_locations where outlet_id = new.outlet_id and is_active;
  if v_location is null then return new; end if;

  insert into inventory_movements (property_id, item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
  select new.property_id, x.item_id, v_location,
         case when x.delta > 0 then 'consume' else 'adjust' end,
         -x.delta, x.unit_cost,
         case when x.delta > 0 then 'Sold' else 'Returned from bill' end,
         new.number, auth.uid()
    from (
      select ii.id as item_id, ii.unit_cost,
             coalesce(sold.qty, 0) - coalesce(taken.qty, 0) as delta
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

/* A room cleaned: the ticked checklist lines linked to items are used up — once per task. */
create or replace function inventory_consume_hk()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_location uuid;
  v_room     text;
  v_ref      text := 'HK ' || left(new.id::text, 8);
begin
  if new.status <> 'cleaned' or old.status = 'cleaned' then return new; end if;
  select id into v_location from inventory_locations
   where property_id = new.property_id and hk_default and is_active;
  if v_location is null then return new; end if;
  select room_number into v_room from rooms where id = new.room_id;

  insert into inventory_movements (property_id, item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
  select new.property_id, x.item_id, v_location,
         case when x.delta > 0 then 'consume' else 'adjust' end,
         -x.delta, x.unit_cost,
         case when x.delta > 0 then 'Room ' || coalesce(v_room, '') else 'Returned: room ' || coalesce(v_room, '') end,
         v_ref, auth.uid()
    from (
      select ii.id as item_id, ii.unit_cost,
             coalesce(used.qty, 0) - coalesce(taken.qty, 0) as delta
        from inventory_items ii
        left join (select (e ->> 'item_id')::uuid as checklist_item, sum((e ->> 'qty')::numeric) as qty
                     from jsonb_array_elements(coalesce(new.checklist, '[]'::jsonb)) e
                    where coalesce((e ->> 'done')::boolean, false)
                      and coalesce((e ->> 'qty')::numeric, 0) > 0
                    group by 1) used on used.checklist_item = ii.hk_checklist_item_id
        left join (select m.item_id, -sum(m.qty) as qty
                     from inventory_movements m
                    where m.reference = v_ref and m.location_id = v_location
                      and m.kind in ('consume', 'adjust')
                    group by m.item_id) taken on taken.item_id = ii.id
       where ii.hk_checklist_item_id is not null and ii.is_active
         and (used.qty is not null or taken.qty is not null)
    ) x
   where x.delta <> 0;
  return new;
end;
$$;

create or replace function inventory_move(
  p_item uuid, p_kind text, p_qty numeric,
  p_from uuid default null, p_to uuid default null,
  p_reason text default '', p_unit_cost numeric default null, p_reference text default ''
) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_item     inventory_items;
  v_transfer uuid := gen_random_uuid();
  v_current  numeric;
  v_on_hand  numeric;
  v_cost     numeric := p_unit_cost;
begin
  if not has_permission('inventory.manage') then
    raise exception 'not permitted';
  end if;
  -- Locked so two movements out of the same stock are checked one at a time.
  select * into v_item from inventory_items where id = p_item and property_id = current_property() for update;
  if v_item.id is null then
    raise exception 'INVENTORY_NO_ITEM: that item is not stocked at this property';
  end if;
  if p_qty is null or p_qty < 0 or (p_qty = 0 and p_kind <> 'adjust') then
    raise exception 'INVENTORY_BAD_QTY: enter a quantity above zero';
  end if;
  if exists (select 1 from inventory_locations l
              where l.id in (p_from, p_to) and (l.property_id <> current_property() or not l.is_active)) then
    raise exception 'INVENTORY_NO_LOCATION: choose a location at this property';
  end if;
  if p_kind = 'wastage' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'INVENTORY_REASON: say why the stock was written off';
  end if;
  v_cost := coalesce(v_cost, v_item.unit_cost);

  -- Anything taken out of a location must be there to take.
  if p_kind in ('issue', 'transfer', 'consume', 'wastage') and p_from is not null then
    select coalesce(sum(qty), 0) into v_on_hand
      from inventory_movements where item_id = p_item and location_id = p_from;
    if p_qty > v_on_hand then
      raise exception 'INVENTORY_SHORT: only % on hand there', greatest(v_on_hand, 0);
    end if;
  end if;

  if p_kind = 'receive' then
    if p_to is null then raise exception 'INVENTORY_NO_LOCATION: choose where it was received'; end if;
    insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
    values (p_item, p_to, 'receive', p_qty, v_cost, coalesce(p_reason, ''), coalesce(p_reference, ''), auth.uid());
    -- The latest purchase price becomes the item's cost.
    if p_unit_cost is not null and p_unit_cost > 0 then
      update inventory_items set unit_cost = p_unit_cost, updated_at = now() where id = p_item;
    end if;

  elsif p_kind in ('issue', 'transfer') and p_to is not null then
    if p_from is null or p_from = p_to then
      raise exception 'INVENTORY_NO_LOCATION: choose two different locations';
    end if;
    insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, transfer_id, created_by)
    values (p_item, p_from, 'transfer', -p_qty, v_cost, coalesce(p_reason, ''), coalesce(p_reference, ''), v_transfer, auth.uid()),
           (p_item, p_to,   'transfer',  p_qty, v_cost, coalesce(p_reason, ''), coalesce(p_reference, ''), v_transfer, auth.uid());

  elsif p_kind in ('issue', 'consume', 'wastage') then
    if p_from is null then raise exception 'INVENTORY_NO_LOCATION: choose where it was taken from'; end if;
    insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
    values (p_item, p_from, p_kind, -p_qty, v_cost, coalesce(p_reason, ''), coalesce(p_reference, ''), auth.uid());

  elsif p_kind = 'adjust' then
    if p_to is null then raise exception 'INVENTORY_NO_LOCATION: choose where it was counted'; end if;
    select coalesce(sum(qty), 0) into v_current from inventory_movements where item_id = p_item and location_id = p_to;
    if p_qty = v_current then return null; end if;
    insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
    values (p_item, p_to, 'adjust', p_qty - v_current, v_cost,
            coalesce(nullif(btrim(p_reason), ''), 'Stock count'), coalesce(p_reference, ''), auth.uid());
  else
    raise exception 'INVENTORY_BAD_KIND: %', p_kind;
  end if;

  return v_transfer;
end;
$$;

-- ── 8. Rooms back in service ─────────────────────────────────────────────────

/*
 * However a room comes back — a ticket closed, a block released on the Rooms
 * page, night audit finding the block expired — it has been worked in, so it
 * is dirty and housekeeping is given a task for it.
 */
create or replace function room_back_in_service()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('out_of_order', 'out_of_service') and new.status = 'available' then
    new.housekeeping_status := 'dirty';
    new.housekeeping_updated_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists rooms_back_in_service on rooms;
create trigger rooms_back_in_service before update of status on rooms
  for each row execute function room_back_in_service();

create or replace function room_back_in_service_task()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.status in ('out_of_order', 'out_of_service') and new.status = 'available'
     and not exists (select 1 from housekeeping_tasks
                      where room_id = new.id and status in ('pending', 'in_progress', 'cleaned')) then
    perform hk_create_task(new.id, 'touch_up', hk_business_today(), 'Back in service — clean before selling');
  end if;
  return null;
end;
$$;

drop trigger if exists rooms_back_in_service_task on rooms;
create trigger rooms_back_in_service_task after update of status on rooms
  for each row execute function room_back_in_service_task();
