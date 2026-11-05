-- ============================================================================
-- Front Office & Operations build-out, part 3: cashier shifts
--
-- Every cashier, at the desk or at an outlet, works a shift: they open it
-- with a float, every cash payment they take or refund lands on it, petty-
-- cash pay-ins, paid-outs and safe drops are recorded against it, and they
-- close it by counting the drawer. The difference between what the system
-- expects and what they counted is the variance, which a manager reviews.
--
--   • cashier_shifts: one per person at a time, per property.
--   • cash_movements: pay-ins, paid-outs (petty cash, or cash advanced to a
--     guest and charged to their folio) and safe drops.
--   • folio_entries.shift_id and pos_payments.shift_id: filled in by trigger
--     from the caller's open shift, so no screen has to remember to.
--   • properties.require_cashier_shift: when on, cash can only be taken by
--     someone with an open shift.
--
-- Permissions:
--   folio.cashier        open and close one's own shift, record movements.
--   folio.cashier_audit  see every shift, close anyone's, review variances.
--
-- Run after 0028_night_audit_lock.sql.
-- ============================================================================

-- ── Setting ─────────────────────────────────────────────────────────────────

alter table properties add column if not exists require_cashier_shift boolean not null default false;

-- property_settings is `select * from properties`; re-issue it so the new
-- column is part of the view (0024 §4).
create or replace view property_settings with (security_invoker = true) as
  select * from properties where id = current_property();

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists cashier_shifts (
  id             uuid primary key default gen_random_uuid(),
  property_id    uuid not null default current_property() references properties on delete restrict,
  staff_id       uuid not null references staff on delete restrict,
  opened_at      timestamptz not null default now(),
  opening_float  numeric(12,2) not null default 0 check (opening_float >= 0),
  closed_at      timestamptz,
  closed_by      uuid references staff on delete set null,
  expected_cash  numeric(12,2),
  counted_cash   numeric(12,2) check (counted_cash >= 0),
  variance       numeric(12,2),
  notes          text not null default '',
  constraint cashier_shift_closed_complete check (
    (closed_at is null and counted_cash is null and expected_cash is null and variance is null)
    or (closed_at is not null and counted_cash is not null and expected_cash is not null and variance is not null)
  )
);

-- One open shift per person, wherever they are.
create unique index if not exists cashier_shifts_one_open_idx
  on cashier_shifts (staff_id) where closed_at is null;
create index if not exists cashier_shifts_property_idx on cashier_shifts (property_id, opened_at desc);

create table if not exists cash_movements (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null default current_property() references properties on delete restrict,
  shift_id    uuid not null references cashier_shifts on delete restrict,
  kind        text not null check (kind in ('pay_in', 'paid_out', 'safe_drop')),
  amount      numeric(12,2) not null check (amount > 0),
  reason      text not null check (btrim(reason) <> ''),
  -- A paid-out on a guest's behalf (a taxi, a courier) is charged to them.
  booking_id  uuid references bookings on delete restrict,
  folio_entry_id uuid references folio_entries on delete restrict,
  created_by  uuid references staff on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists cash_movements_shift_idx on cash_movements (shift_id);
create index if not exists cash_movements_booking_idx on cash_movements (booking_id) where booking_id is not null;

alter table folio_entries add column if not exists shift_id uuid references cashier_shifts on delete restrict;
alter table pos_payments  add column if not exists shift_id uuid references cashier_shifts on delete restrict;
create index if not exists folio_entries_shift_idx on folio_entries (shift_id) where shift_id is not null;
create index if not exists pos_payments_shift_idx  on pos_payments (shift_id)  where shift_id is not null;

-- ── Tagging payments with the shift ─────────────────────────────────────────

/* The caller's open shift at the property they are working in, or null. */
create or replace function my_open_shift()
returns uuid language sql stable security definer set search_path = public as $$
  select id from cashier_shifts
   where staff_id = auth.uid() and closed_at is null and property_id = current_property()
   limit 1;
$$;

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

drop trigger if exists folio_entries_shift on folio_entries;
create trigger folio_entries_shift before insert on folio_entries
  for each row execute function cashier_tag_payment();
drop trigger if exists pos_payments_shift on pos_payments;
create trigger pos_payments_shift before insert on pos_payments
  for each row execute function cashier_tag_payment();

-- ── What the drawer should hold ─────────────────────────────────────────────

/*
 * Float + cash taken − cash refunded (folios and outlets, voids excluded)
 * + pay-ins − paid-outs − safe drops.
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
    + coalesce((select sum(case when kind = 'pay_in' then amount else -amount end)
                  from cash_movements where shift_id = p_shift), 0),
  2);
$$;

-- ── Opening, moving cash, closing ───────────────────────────────────────────

create or replace function cashier_open_shift(p_float numeric default 0)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
begin
  if not has_permission('folio.cashier') then
    raise exception 'not permitted';
  end if;
  if p_float is null or p_float < 0 then
    raise exception 'CASHIER_BAD_AMOUNT: the float cannot be negative';
  end if;
  if exists (select 1 from cashier_shifts where staff_id = auth.uid() and closed_at is null) then
    raise exception 'CASHIER_SHIFT_OPEN: you already have an open shift; close it first';
  end if;
  insert into cashier_shifts (staff_id, opening_float)
  values (auth.uid(), round(p_float, 2))
  returning id into v_id;
  return v_id;
end;
$$;

/*
 * A pay-in, paid-out or safe drop on the caller's open shift. A paid-out with
 * a booking is cash handed out on the guest's behalf, so it is also charged
 * to their folio (untaxed — it is a disbursement, not a sale).
 */
create or replace function cashier_cash_movement(
  p_kind text, p_amount numeric, p_reason text, p_booking uuid default null
) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_shift uuid := my_open_shift();
  v_entry uuid;
  v_id    uuid;
begin
  if not has_permission('folio.cashier') then
    raise exception 'not permitted';
  end if;
  if v_shift is null then
    raise exception 'CASHIER_NO_SHIFT: open your cash shift first';
  end if;
  if p_kind not in ('pay_in', 'paid_out', 'safe_drop') then
    raise exception 'CASHIER_BAD_KIND: %', p_kind;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'CASHIER_BAD_AMOUNT: enter an amount above zero';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'CASHIER_REASON: give a reason';
  end if;
  if p_booking is not null and p_kind <> 'paid_out' then
    raise exception 'CASHIER_BAD_KIND: only a paid-out can be charged to a guest';
  end if;

  if p_booking is not null then
    if not has_permission('folio.post') then
      raise exception 'not permitted';
    end if;
    if not exists (select 1 from bookings where id = p_booking and status = 'checked_in'
                     and property_id = current_property()) then
      raise exception 'CASHIER_NOT_IN_HOUSE: a paid-out can only be charged to a guest in house';
    end if;
    insert into folio_entries (booking_id, kind, description, amount, tax_amount, tax_rate, created_by)
    values (p_booking, 'extra', 'Paid out: ' || btrim(p_reason), round(p_amount, 2), 0, 0, auth.uid())
    returning id into v_entry;
  end if;

  insert into cash_movements (shift_id, kind, amount, reason, booking_id, folio_entry_id, created_by)
  values (v_shift, p_kind, round(p_amount, 2), btrim(p_reason), p_booking, v_entry, auth.uid())
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function cashier_close_shift(p_shift uuid, p_counted numeric, p_notes text default '')
returns cashier_shifts language plpgsql volatile security definer set search_path = public as $$
declare
  v_shift    cashier_shifts;
  v_expected numeric;
begin
  select * into v_shift from cashier_shifts where id = p_shift for update;
  if not found or not can_access_property(v_shift.property_id) then
    raise exception 'CASHIER_NO_SHIFT: that shift does not exist';
  end if;
  if not (
    (v_shift.staff_id = auth.uid() and has_permission('folio.cashier'))
    or has_permission('folio.cashier_audit')
  ) then
    raise exception 'not permitted';
  end if;
  if v_shift.closed_at is not null then
    raise exception 'CASHIER_SHIFT_CLOSED: that shift is already closed';
  end if;
  if p_counted is null or p_counted < 0 then
    raise exception 'CASHIER_BAD_AMOUNT: enter the cash you counted';
  end if;

  v_expected := cashier_shift_expected(p_shift);
  update cashier_shifts
     set closed_at = now(),
         closed_by = auth.uid(),
         expected_cash = v_expected,
         counted_cash = round(p_counted, 2),
         variance = round(p_counted - v_expected, 2),
         notes = coalesce(btrim(p_notes), '')
   where id = p_shift
  returning * into v_shift;
  return v_shift;
end;
$$;

-- ── Row level security ──────────────────────────────────────────────────────
-- Reads only; every write goes through the functions above.

alter table cashier_shifts enable row level security;
alter table cash_movements enable row level security;

drop policy if exists cashier_shifts_select   on cashier_shifts;
drop policy if exists cashier_shifts_property on cashier_shifts;
create policy cashier_shifts_select on cashier_shifts for select
  using (staff_id = auth.uid() or has_permission('folio.cashier_audit') or has_permission('reports.financial'));
create policy cashier_shifts_property on cashier_shifts as restrictive for all
  using (can_access_property(property_id)) with check (can_access_property(property_id));

drop policy if exists cash_movements_select   on cash_movements;
drop policy if exists cash_movements_property on cash_movements;
create policy cash_movements_select on cash_movements for select
  using (
    has_permission('folio.cashier_audit') or has_permission('reports.financial')
    or exists (select 1 from cashier_shifts s where s.id = shift_id and s.staff_id = auth.uid())
  );
create policy cash_movements_property on cash_movements as restrictive for all
  using (can_access_property(property_id)) with check (can_access_property(property_id));

do $$
declare
  t text;
begin
  foreach t in array array['cashier_shifts', 'cash_movements'] loop
    execute format('drop trigger if exists %I on %I', t || '_audit', t);
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function audit_row(%L)',
      t || '_audit', t, 'folio');
  end loop;
end;
$$;

-- ── Permissions ─────────────────────────────────────────────────────────────

insert into role_permissions (role_key, permission)
select r, p from (values
  ('front_desk', 'folio.cashier'), ('fo_cashier', 'folio.cashier'),
  -- The night auditor audits the drawers, so sees and can close every shift.
  ('night_auditor', 'folio.cashier'), ('night_auditor', 'folio.cashier_audit'),
  ('pos_cashier', 'folio.cashier'), ('fb_manager', 'folio.cashier'),
  ('front_office_manager', 'folio.cashier'), ('front_office_manager', 'folio.cashier_audit'),
  ('manager', 'folio.cashier'), ('manager', 'folio.cashier_audit'),
  ('finance', 'folio.cashier'), ('finance', 'folio.cashier_audit')
) as seed (r, p)
where exists (select 1 from roles where key = seed.r)
on conflict do nothing;
