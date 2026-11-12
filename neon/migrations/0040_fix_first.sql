-- ============================================================================
-- The database half of the "Fix these first" list in
-- docs/interconnection-audit-2026-11-07.md (the TypeScript half is in the
-- check-out, night-audit, booking and staff actions).
--
--  3. Outlet bills and events billed to a stay that is already invoiced post
--     to its "After invoice" folio — charges, the "already paid" credit and
--     the payment record together — instead of failing with FOLIO_INVOICED.
--  4. A folio carries at most one issued invoice.
--  6. Night audit closes only the lines that belong to the day: a line for a
--     later night waits for that night's audit.
--  9. A booking's room type follows the room it is in, so an upgrade counts
--     against the new type's inventory (and is refused if it is full).
-- 10. Checking out part 1 of a stay split by date hands the room to part 2:
--     part 2 is checked in, the room stays occupied and is not dirtied. A
--     room another checked-in guest is in is never freed.
-- 11. Event deposits and payments are tagged with the cashier's shift and
--     counted in the drawer and the payments report; cancelling an event
--     billed to a room voids its lines on the guest's folio.
-- 12. A person who loses access to the hotel they had switched to is back at
--     their own hotel: current_property() re-checks access.
-- 13. Removing a staff member who has any history deactivates them (and ends
--     their sessions) instead of deleting the account and its trail.
--
-- Run after 0039_interconnection_fixes.sql.
-- ============================================================================

-- ── 3. Postings to an invoiced stay ─────────────────────────────────────────

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
  if v_booking.status not in ('checked_in', 'checked_out') then
    raise exception 'EVENT_BOOKING_NOT_RESIDENT'
      using hint = 'An event can only be billed to a stay the guest has actually checked into.';
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

-- ── 4. One issued invoice per folio ─────────────────────────────────────────

-- 0039's index was not unique, so a double-clicked check-out could issue two.
-- Refuse to go on if that has already happened, rather than guess which to keep.
do $$
declare
  v_dupes text;
begin
  select string_agg(n, ', ') into v_dupes from (
    select string_agg(number, ' + ' order by issued_at) as n
      from invoices
     where status = 'issued' and folio_id is not null
     group by folio_id
    having count(*) > 1
  ) d;
  if v_dupes is not null then
    raise exception 'DUPLICATE_INVOICES: these folios carry two issued invoices; cancel the extra ones, then run this migration again: %', v_dupes;
  end if;
end;
$$;

drop index if exists invoices_folio_issued_idx;
create unique index if not exists invoices_one_issued_per_folio
  on invoices (folio_id) where status = 'issued' and folio_id is not null;

-- ── 6. Night audit closes the day's lines, not later nights' ────────────────

create or replace function close_folio_day(p_date date)
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  v_count int;
begin
  if not has_permission('frontdesk.night_audit') then
    raise exception 'not permitted';
  end if;
  -- A line posted ahead for a later night (an event, a pre-posted night)
  -- belongs to that night's audit; stamping it today put its revenue on the
  -- wrong day and inflated room revenue and ADR.
  update folio_entries
     set night_audit_date = p_date
   where night_audit_date is null
     and property_id = current_property()
     and created_at < now()
     and (stay_date is null or stay_date <= p_date);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ── 9. A booking's room type follows its room ───────────────────────────────

/*
 * A one-room booking put in a room of another type (an upgrade, a downgrade)
 * becomes a booking of that type. Named to fire before
 * bookings_enforce_inventory, which then checks the new type's capacity and
 * refuses the move if that type is full.
 */
create or replace function booking_align_room_type()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type uuid;
begin
  if new.room_id is null or new.rooms_count <> 1 then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.room_id is not distinct from old.room_id then
    return new;
  end if;
  select room_type_id into v_type from rooms where id = new.room_id;
  if v_type is not null and v_type is distinct from new.room_type_id then
    new.room_type_id := v_type;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_align_room_type on bookings;
create trigger bookings_align_room_type
  before insert or update of room_id on bookings
  for each row execute function booking_align_room_type();

-- ── 10. Room handover on a split stay, and same-day turnovers ───────────────

create or replace function sync_room_status()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  v_next uuid;
begin
  if tg_op = 'UPDATE' and old.room_id is not null
     and old.status = 'checked_in'
     and (old.room_id is distinct from new.room_id or new.status <> 'checked_in')
  then
    -- 0040: part 1 of a stay split by date, leaving on (not before) the split
    -- date, hands the room to part 2. The guest never leaves the room, so it
    -- is not freed, not dirtied and no check-out clean is raised.
    if new.status = 'checked_out' and new.room_id is not distinct from old.room_id then
      select id into v_next
        from bookings
       where split_from_id = new.id
         and room_id = old.room_id
         and status in ('tentative', 'confirmed')
         and check_in <= new.check_out
       order by check_in
       limit 1;
      if v_next is not null then
        update bookings
           set status = 'checked_in', checked_in_at = now(), checked_in_by = auth.uid()
         where id = v_next;
        return new;
      end if;
    end if;

    -- 0040: a same-day turnover where the next guest is already in the room
    -- leaves it as it is; only a room nobody is checked in to is freed.
    if not exists (select 1 from bookings
                    where room_id = old.room_id and status = 'checked_in' and id <> new.id) then
      update rooms
         set status = case when status = 'occupied' then 'available'::room_status else status end,
             housekeeping_status = 'dirty',
             housekeeping_updated_at = now()
       where id = old.room_id;

      perform hk_create_task(old.room_id, 'checkout', hk_business_today(),
        case when new.room_id is distinct from old.room_id and new.status = 'checked_in'
             then 'Guest moved to another room' else '' end);
    end if;
  end if;

  if new.status = 'checked_in' and new.room_id is not null then
    update rooms
       set status = 'occupied'
     where id = new.room_id
       and status in ('available', 'occupied');
  end if;

  return new;
end;
$$;

-- ── 11. Event money and cancellations ───────────────────────────────────────

-- Event deposits and payments are cash in the drawer like any other.
alter table event_payments add column if not exists shift_id uuid references cashier_shifts on delete restrict;
create index if not exists event_payments_shift_idx on event_payments (shift_id) where shift_id is not null;

create or replace function cashier_tag_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cash   boolean;
  v_shift  uuid;
  v_strict boolean;
begin
  if tg_table_name = 'folio_entries' then
    if new.kind not in ('payment', 'refund') then return new; end if;
    v_cash := new.method = 'cash';
  elsif tg_table_name = 'event_payments' then
    -- A transfer to a folio or a company is not money changing hands.
    if new.kind not in ('advance', 'payment', 'refund') then return new; end if;
    v_cash := new.method = 'cash';
  else
    if new.kind = 'room_charge' or new.kind = 'loyalty_points' then return new; end if;
    v_cash := new.kind = 'cash';
  end if;

  if new.shift_id is null then
    v_shift := my_open_shift();
    new.shift_id := v_shift;
  end if;

  -- Gateway payments (the webhook) and other system postings have no person
  -- behind them, so the rule only applies to someone signed in.
  if v_cash and new.shift_id is null and auth.uid() is not null then
    select require_cashier_shift into v_strict from properties where id = current_property();
    if coalesce(v_strict, false) then
      raise exception 'CASHIER_NO_SHIFT: open your cash shift before taking or refunding cash';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists event_payments_shift on event_payments;
create trigger event_payments_shift before insert on event_payments
  for each row execute function cashier_tag_payment();

/*
 * Float + cash taken − cash refunded (folios, outlets and events, voids
 * excluded) + pay-ins − paid-outs − safe drops. Mirrored by shiftBreakdown()
 * in app/lib/cashier.ts.
 */
create or replace function cashier_shift_expected(p_shift uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(
    coalesce((select opening_float from cashier_shifts where id = p_shift), 0)
    + coalesce((select sum(case when kind = 'payment' then amount else -amount end)
                  from folio_entries
                 where shift_id = p_shift and method = 'cash' and kind in ('payment', 'refund')
                   and voided_at is null), 0)
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

/* Money taken and refunded by method: folios, and now events too. */
create or replace function report_payments(p_from date, p_to date)
returns table (method text, taken numeric, refunded numeric, count int)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  return query
  select m.method,
         sum(m.taken)    as taken,
         sum(m.refunded) as refunded,
         sum(m.n)::int   as count
    from (
      select coalesce(f.method::text, 'unspecified') as method,
             case when f.kind = 'payment' then f.amount else 0 end                as taken,
             case when f.kind = 'refund'  then f.amount + f.tax_amount else 0 end as refunded,
             1 as n
        from folio_entries f
       where f.voided_at is null
         and f.property_id = current_property()
         and f.kind in ('payment', 'refund')
         and local_day(f.created_at) between p_from and p_to
      union all
      select coalesce(e.method::text, 'unspecified'),
             case when e.kind in ('advance', 'payment') then e.amount else 0 end,
             case when e.kind = 'refund' then e.amount else 0 end,
             1
        from event_payments e
       where e.voided_at is null
         and e.property_id = current_property()
         and e.kind in ('advance', 'payment', 'refund')
         and local_day(e.created_at) between p_from and p_to
    ) m
   group by m.method
   order by 2 desc;
end;
$$;

/*
 * Cancelling an event that was charged to a guest's room takes it off their
 * folio: the event lines and the deposit credit are voided with the reason,
 * and so is the transfer record. If the folio has been invoiced since, or the
 * lines are on a day night audit has closed, the cancel is refused with a
 * reason the desk can act on (a credit note, or an allowance on the folio).
 */
create or replace function event_cancel(p_event uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_e   record;
  v_pay record;
begin
  if not (has_permission('events.book') or has_permission('events.manage')) then
    raise exception 'not permitted';
  end if;
  if length(trim(coalesce(p_reason, ''))) = 0 then
    raise exception 'EVENT_CANCEL_REASON' using hint = 'Give a reason for cancelling.';
  end if;

  select * into v_e from event_bookings where id = p_event for update;
  if v_e is null then
    raise exception 'EVENT_NOT_FOUND' using hint = 'That event no longer exists.';
  end if;
  if v_e.status = 'cancelled' then
    raise exception 'EVENT_ALREADY_CANCELLED' using hint = 'This event is already cancelled.';
  end if;
  if exists (select 1 from invoices where event_id = p_event and status = 'issued') then
    raise exception 'EVENT_INVOICED'
      using hint = 'This event has been invoiced. Cancel the invoice before cancelling the event.';
  end if;

  for v_pay in
    select * from event_payments
     where event_id = p_event and kind = 'room_charge' and voided_at is null
  loop
    begin
      update folio_entries
         set voided_at = now(), voided_by = auth.uid(),
             void_reason = 'Event cancelled: ' || trim(p_reason)
       where booking_id = v_pay.booking_id
         and folio_id = v_pay.folio_id
         and reference = v_e.number
         and kind in ('extra', 'adjustment')
         and voided_at is null;
    exception when others then
      raise exception 'EVENT_ON_CLOSED_FOLIO: the event is on a guest folio that is invoiced or closed by night audit; issue a credit note or post an allowance, then cancel the event'
        using detail = sqlerrm;
    end;
    update event_payments
       set voided_at = now(), voided_by = auth.uid(), void_reason = 'Event cancelled: ' || trim(p_reason)
     where id = v_pay.id;
  end loop;

  update event_bookings set
    status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
    cancel_reason = trim(p_reason), updated_at = now()
  where id = p_event;
end;
$$;

-- ── 12. current_property() re-checks access ─────────────────────────────────

/*
 * The property the caller is working in: the one they switched to, but only
 * while they still have access to it; otherwise the one they belong to.
 * Before 0040 a person whose "all properties" access was taken away kept
 * working in whichever hotel they had switched to.
 */
create or replace function current_property()
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
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

-- ── 13. Removing a staff member keeps their history ─────────────────────────

/*
 * "Remove account". Someone who has ever done anything (a folio line, a cash
 * shift, attendance, a ticket: any row anywhere that points at them) is
 * deactivated and signed out, so their name stays on what they did and their
 * HR records survive. Only an account with no trail at all is deleted.
 * Returns 'deactivated' or 'deleted'.
 */
create or replace function staff_remove(p_staff uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  v_ref     record;
  v_found   boolean;
  v_history boolean := false;
begin
  if not has_permission('staff.manage') then
    raise exception 'not permitted';
  end if;
  if p_staff = auth.uid() then
    raise exception 'STAFF_SELF: you cannot remove your own account';
  end if;
  if not exists (select 1 from staff where id = p_staff) then
    raise exception 'STAFF_NOT_FOUND: that staff member no longer exists';
  end if;

  -- Every column, in any table, that references staff or their sign-in.
  for v_ref in
    select c.conrelid::regclass as tbl, a.attname as col
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
     where c.contype = 'f'
       and c.confrelid in ('public.staff'::regclass, 'auth.users'::regclass)
       and c.conrelid <> 'public.staff'::regclass
       and array_length(c.conkey, 1) = 1
       -- Their own sign-in plumbing is not history.
       and c.conrelid::regclass::text not in ('auth.sessions', 'auth.refresh_tokens', 'auth.identities',
                                              'auth.mfa_factors', 'auth.one_time_tokens')
  loop
    execute format('select exists (select 1 from %s where %I = $1)', v_ref.tbl, v_ref.col)
      into v_found using p_staff;
    if v_found then
      v_history := true;
      exit;
    end if;
  end loop;

  if v_history then
    update staff
       set is_active = false, sessions_revoked_at = now()
     where id = p_staff;
    perform log_event('staff', 'deactivate', p_staff::text,
      'Deactivated instead of deleted: their records stay attributed to them');
    return 'deactivated';
  end if;

  delete from auth.users where id = p_staff;
  return 'deleted';
end;
$$;

