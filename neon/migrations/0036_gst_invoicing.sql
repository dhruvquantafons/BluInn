-- ============================================================================
-- Commercial, part 1: GST tax invoices and credit notes
--
-- Until now an invoice carried one rate-wise summary and nothing else a GST
-- invoice needs (docs/pms-review.md §1.7): no SAC code, no CGST/SGST/IGST, the
-- buyer's GSTIN always blank, no credit notes, and an allowance never reduced
-- the tax. This migration adds what the database has to know:
--
--   • properties.tax_regime ('gst' | 'simple'), the hotel's GST state code,
--     default SAC codes (rooms, food and beverage, events, other) and a
--     credit-note series prefix. A hotel outside India sets 'simple' and keeps
--     the plain invoice.
--   • pos_outlets.sac_code: food and beverage outlets default to 996331.
--   • folio_entries.sac_code and revenue_dept, filled in on insert from the
--     kind of charge and the document it came from (its `reference`), so every
--     path that posts a charge is covered without each having to remember.
--     revenue_dept also feeds the manager's flash report (0037).
--   • folio_entries.applies_to: an allowance can name the charge it reduces.
--     It then takes that charge's SAC and tax rate and lowers the taxable value
--     on the invoice, which is how GST treats a discount given before billing.
--   • invoices: the supplier's GSTIN and state, the buyer's state, whether the
--     supply is inter-state, and the CGST/SGST/IGST totals, frozen at issue.
--   • credit_notes, issued only through credit_note_issue(): a numbered
--     document in its own series against an issued invoice. It credits the
--     folio (or reduces what is owed on an event), and cannot be raised after
--     30 November following the end of the invoice's financial year
--     (CGST Act s.34).
--   • An invoice under GST may only be cancelled until the 11th of the month
--     after it was issued (when that month's GSTR-1 is due) and only while no
--     credit note stands against it. After that, a credit note is the only
--     correction.
--   • report_tax_summary: grouped by SAC and rate with the CGST/SGST/IGST
--     split. It now counts outlet sales paid at the outlet, nets off
--     allowances and subtracts credit notes.
--
-- Permission: folio.credit_note, seeded to every role that approves refunds.
--
-- The GST rules applied here (SAC codes, place of supply, time limits) are
-- India's as understood in November 2026. Confirm them with the hotel's
-- accountant before the first invoice, as with the tax slabs (0005).
--
-- Run after 0035_trim_roles.sql.
-- ============================================================================

-- ── 1. Property settings ────────────────────────────────────────────────────

alter table properties add column if not exists tax_regime text not null default 'gst'
  check (tax_regime in ('gst', 'simple'));
alter table properties add column if not exists gst_state_code text not null default ''
  check (gst_state_code = '' or gst_state_code ~ '^[0-9]{2}$');
alter table properties add column if not exists sac_room  text not null default '996311' check (sac_room  ~ '^[0-9]{0,8}$');
alter table properties add column if not exists sac_fnb   text not null default '996331' check (sac_fnb   ~ '^[0-9]{0,8}$');
alter table properties add column if not exists sac_event text not null default '996334' check (sac_event ~ '^[0-9]{0,8}$');
alter table properties add column if not exists sac_other text not null default '999799' check (sac_other ~ '^[0-9]{0,8}$');
alter table properties add column if not exists credit_note_prefix text not null default 'CN'
  check (credit_note_prefix ~ '^[A-Z0-9-]{1,6}$');

-- A hotel already set up outside India keeps the plain invoice.
update properties set tax_regime = 'simple'
 where btrim(country) <> '' and lower(btrim(country)) <> 'india';

-- The first two digits of a GSTIN are the state code.
update properties set gst_state_code = substr(gstin, 1, 2)
 where gst_state_code = '' and gstin ~ '^[0-9]{2}';

create or replace view property_settings with (security_invoker = true) as
  select * from properties where id = current_property();

alter table pos_outlets add column if not exists sac_code text not null default ''
  check (sac_code ~ '^[0-9]{0,8}$');
update pos_outlets set sac_code = '996331'
 where sac_code = '' and kind in ('restaurant', 'bar', 'room_service', 'mini_bar');

-- ── 2. What each folio line is, for tax and for revenue ─────────────────────

alter table folio_entries add column if not exists sac_code text not null default '';
alter table folio_entries add column if not exists revenue_dept text
  check (revenue_dept in ('rooms', 'fnb', 'laundry', 'spa', 'events', 'other', 'paid_out'));
alter table folio_entries add column if not exists applies_to uuid references folio_entries on delete restrict;
alter table folio_entries add column if not exists credit_note_id uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'folio_entries_applies_to_allowance') then
    alter table folio_entries add constraint folio_entries_applies_to_allowance
      check (applies_to is null or kind = 'adjustment');
  end if;
end;
$$;

create index if not exists folio_entries_applies_to_idx on folio_entries (applies_to) where applies_to is not null;

/*
 * The department and SAC code of a charge. A charge's `reference` already
 * holds the document it came from: a POS bill number for outlet charges
 * (0017, 0032), an event number for an event billed to a room (0019).
 * Cash paid out on a guest's behalf (0029) is a reimbursement, not a supply,
 * so it has no SAC and no revenue department of its own.
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
    -- Cancellation, no-show and early/late fees follow the room's SAC
    -- (CBIC Circular 178/10/2022).
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

/*
 * Fills sac_code and revenue_dept on insert (a caller may set them itself,
 * e.g. a charge posted against a chosen department). An allowance that names
 * a charge takes that charge's SAC, department and tax rate, and its tax
 * portion is worked out from its gross amount, so the invoice and the tax
 * report can lower the taxable value by exactly that much.
 *
 * Named to fire after folio_entries_inherit_property (0024), so property_id
 * is already the booking's.
 */
create or replace function folio_entry_tax_class()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_charge  record;
  v_class   record;
  v_already numeric;
begin
  if new.kind = 'adjustment' then
    if new.applies_to is null then
      return new;
    end if;

    select * into v_charge from folio_entries where id = new.applies_to;
    if v_charge.id is null or v_charge.booking_id <> new.booking_id
       or v_charge.kind not in ('room', 'fee', 'penalty', 'extra') then
      raise exception 'ALLOWANCE_BAD_CHARGE: an allowance can only reduce a charge on the same stay';
    end if;
    if v_charge.voided_at is not null then
      raise exception 'ALLOWANCE_BAD_CHARGE: that charge has been voided';
    end if;

    select coalesce(sum(amount), 0) into v_already
      from folio_entries
     where applies_to = new.applies_to and voided_at is null;
    if v_already + new.amount > v_charge.amount + v_charge.tax_amount + 0.005 then
      raise exception 'ALLOWANCE_EXCEEDS_CHARGE: only % of that charge is left to reduce',
        round(v_charge.amount + v_charge.tax_amount - v_already, 2);
    end if;

    new.sac_code     := v_charge.sac_code;
    new.revenue_dept := v_charge.revenue_dept;
    new.tax_rate     := v_charge.tax_rate;
    new.tax_amount   := round(new.amount - new.amount / (1 + v_charge.tax_rate / 100), 2);
    return new;
  end if;

  if new.kind not in ('room', 'fee', 'penalty', 'extra') then
    return new;
  end if;

  select * into v_class
    from folio_charge_class(coalesce(new.property_id, current_property()), new.kind, new.description, new.reference);

  new.revenue_dept := coalesce(new.revenue_dept, v_class.dept);
  if coalesce(new.sac_code, '') = '' then
    new.sac_code := case
      -- A charge posted against a department takes that department's code.
      when new.revenue_dept = 'fnb' and v_class.dept <> 'fnb'
        then (select sac_fnb from properties where id = coalesce(new.property_id, current_property()))
      when new.revenue_dept = 'rooms' and v_class.dept <> 'rooms'
        then (select sac_room from properties where id = coalesce(new.property_id, current_property()))
      else coalesce(v_class.sac, '')
    end;
  end if;
  return new;
end;
$$;

drop trigger if exists folio_entries_tax_class on folio_entries;
create trigger folio_entries_tax_class before insert on folio_entries
  for each row execute function folio_entry_tax_class();

-- Lines already posted. folio_entries_guard (0028) freezes posted lines, so
-- it steps aside for this one classification and is switched straight back.
alter table folio_entries disable trigger folio_entries_guard;

update folio_entries f
   set (revenue_dept, sac_code) = (
     select c.dept, coalesce(c.sac, '')
       from folio_charge_class(f.property_id, f.kind, f.description, f.reference) c)
 where f.kind in ('room', 'fee', 'penalty', 'extra')
   and f.revenue_dept is null;

-- Allowances already linked to nothing stay settlement lines.

alter table folio_entries enable trigger folio_entries_guard;

-- ── 3. Invoices: the GST facts, frozen at issue ─────────────────────────────

-- Invoices issued before this migration printed the plain way; they stay so.
alter table invoices add column if not exists tax_regime text not null default 'simple'
  check (tax_regime in ('gst', 'simple'));
alter table invoices add column if not exists supplier_gstin      text not null default '';
alter table invoices add column if not exists supplier_state_code text not null default '';
alter table invoices add column if not exists bill_to_state_code  text not null default '';
alter table invoices add column if not exists is_interstate       boolean not null default false;
alter table invoices add column if not exists cgst_total numeric(12,2) not null default 0 check (cgst_total >= 0);
alter table invoices add column if not exists sgst_total numeric(12,2) not null default 0 check (sgst_total >= 0);
alter table invoices add column if not exists igst_total numeric(12,2) not null default 0 check (igst_total >= 0);

-- The last day a GST invoice may be cancelled: the 11th of the next month,
-- when the GSTR-1 that reports it is due.
create or replace function gst_cancel_deadline(p_issued date)
returns date language sql immutable as $$
  select (date_trunc('month', p_issued) + interval '1 month' + interval '10 days')::date;
$$;

-- The last day a credit note may be raised against an invoice: 30 November
-- after the end of the invoice's financial year (CGST Act s.34(2), as amended
-- from 1 October 2022).
create or replace function credit_note_deadline(p_invoice_date date)
returns date language sql immutable as $$
  select make_date(
    case when extract(month from p_invoice_date) >= 4
         then extract(year from p_invoice_date)::int + 1
         else extract(year from p_invoice_date)::int end,
    11, 30);
$$;

/*
 * Restated from 0014. Every column is frozen except the cancellation fields,
 * compared with `is distinct from` so a change to or from NULL is caught as
 * well (review §1.3), and columns added later are frozen without having to be
 * listed here.
 */
create or replace function invoices_immutable()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_mutable text[] := array['status', 'cancelled_at', 'cancelled_by', 'cancel_reason'];
begin
  if tg_op = 'DELETE' then
    raise exception 'INVOICE_IMMUTABLE' using hint = 'Invoices cannot be deleted. Cancel the invoice instead.';
  end if;
  if old.status = 'cancelled' then
    raise exception 'INVOICE_CANCELLED' using hint = 'This invoice is already cancelled.';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'INVOICE_IMMUTABLE' using hint = 'An issued invoice cannot be changed. Cancel it and issue a new one.';
  end if;

  if new.status = 'cancelled' then
    if exists (select 1 from credit_notes where invoice_id = old.id) then
      raise exception 'INVOICE_HAS_CREDIT_NOTE: a credit note has been issued against %; issue another credit note instead of cancelling',
        old.number;
    end if;
    if old.tax_regime = 'gst' and local_day(now()) > gst_cancel_deadline(local_day(old.issued_at)) then
      raise exception 'INVOICE_CANCEL_WINDOW: % was reported for its month; correct it with a credit note',
        old.number;
    end if;
  end if;
  return new;
end;
$$;

-- ── 4. Credit notes ─────────────────────────────────────────────────────────

create table if not exists credit_notes (
  id                 uuid primary key default gen_random_uuid(),
  property_id        uuid not null default current_property() references properties on delete restrict,
  -- Printed number, e.g. CN/2026-27/0001: its own series, never reused.
  number             text not null,
  series             text not null,
  financial_year     text not null,
  seq                int  not null check (seq > 0),
  invoice_id         uuid not null references invoices on delete restrict,
  booking_id         uuid references bookings on delete restrict,
  folio_id           uuid references folios on delete restrict,
  event_id           uuid references event_bookings on delete restrict,
  reason_code        text not null
                     check (reason_code in ('deficiency', 'discount', 'cancellation', 'billing_error', 'other')),
  note               text not null default '',
  -- Copied from the invoice, which is what a credit note must quote.
  bill_to_name       text not null,
  bill_to_address    text not null default '',
  bill_to_gstin      text not null default '',
  bill_to_state_code text not null default '',
  place_of_supply    text not null default '',
  tax_regime         text not null check (tax_regime in ('gst', 'simple')),
  is_interstate      boolean not null default false,
  currency           text not null default 'INR',
  net_total          numeric(12,2) not null check (net_total >= 0),
  tax_total          numeric(12,2) not null check (tax_total >= 0),
  cgst_total         numeric(12,2) not null default 0 check (cgst_total >= 0),
  sgst_total         numeric(12,2) not null default 0 check (sgst_total >= 0),
  igst_total         numeric(12,2) not null default 0 check (igst_total >= 0),
  grand_total        numeric(12,2) not null check (grand_total > 0),
  -- [{ "sac": "996311", "rate": 5, "net": 1000, "tax": 50, "cgst": 25, "sgst": 25, "igst": 0 }]
  tax_breakdown      jsonb not null default '[]',
  -- [{ "line": 0, "description": ..., "sac": ..., "dept": ..., "rate": 5,
  --    "net": ..., "tax": ..., "cgst": ..., "sgst": ..., "igst": ..., "total": ... }]
  -- `line` is the position of the credited line on the invoice.
  lines              jsonb not null,
  issued_at          timestamptz not null default now(),
  issued_by          uuid references staff on delete set null
);

create unique index if not exists credit_notes_number_idx on credit_notes (property_id, number);
create unique index if not exists credit_notes_seq_idx on credit_notes (property_id, series, financial_year, seq);
create index if not exists credit_notes_invoice_idx on credit_notes (invoice_id);
create index if not exists credit_notes_issued_idx on credit_notes (property_id, issued_at desc);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'folio_entries_credit_note_fk') then
    alter table folio_entries add constraint folio_entries_credit_note_fk
      foreign key (credit_note_id) references credit_notes on delete restrict;
  end if;
end;
$$;

-- A credit note is a tax document: never changed, never deleted.
create or replace function credit_notes_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'CREDIT_NOTE_IMMUTABLE: a credit note cannot be changed or deleted; issue another to correct it';
end;
$$;

drop trigger if exists credit_notes_immutable_trg on credit_notes;
create trigger credit_notes_immutable_trg before update or delete on credit_notes
  for each row execute function credit_notes_immutable();

alter table credit_notes enable row level security;
drop policy if exists credit_notes_select   on credit_notes;
drop policy if exists credit_notes_property on credit_notes;
create policy credit_notes_select on credit_notes for select
  using (has_permission('folio.view') or has_permission('bookings.view') or has_permission('reports.financial'));
create policy credit_notes_property on credit_notes as restrictive for all
  using (can_access_property(property_id)) with check (can_access_property(property_id));

drop trigger if exists credit_notes_audit on credit_notes;
create trigger credit_notes_audit after insert or update or delete on credit_notes
  for each row execute function audit_row('folio');

/*
 * Issues a credit note against an invoice, all in one transaction: the lines
 * are checked against what is still uncredited, the number is claimed, the
 * note is written and the folio is credited. p_lines is
 * [{ "line": <index on the invoice>, "amount": <gross to credit> }]; null
 * credits everything still open on the invoice.
 */
create or replace function credit_note_issue(
  p_invoice uuid, p_reason_code text, p_note text default '', p_lines jsonb default null
) returns credit_notes
language plpgsql volatile security definer set search_path = public as $$
declare
  v_inv        invoices;
  v_today      date := local_day(now());
  v_line       jsonb;
  v_idx        int;
  v_total      numeric;
  v_cr_total   numeric;
  v_cr_net     numeric;
  v_cr_tax     numeric;
  v_left       numeric;
  v_req        numeric;
  v_rate       numeric;
  v_net        numeric;
  v_tax        numeric;
  v_cgst       numeric;
  v_sgst       numeric;
  v_igst       numeric;
  v_lines      jsonb := '[]';
  v_requested  numeric := 0;
  v_used       numeric := 0;
  v_prefix     text;
  v_inv_prefix text;
  v_fy         text;
  v_seq        int;
  v_cn         credit_notes;
begin
  if not has_permission('folio.credit_note') then
    raise exception 'not permitted';
  end if;

  select * into v_inv from invoices where id = p_invoice for update;
  if v_inv.id is null or not can_access_property(v_inv.property_id) then
    raise exception 'CREDIT_NOTE_NO_INVOICE: invoice not found';
  end if;
  if v_inv.status <> 'issued' then
    raise exception 'CREDIT_NOTE_INVOICE_CANCELLED: % is cancelled', v_inv.number;
  end if;
  if p_reason_code is null
     or p_reason_code not in ('deficiency', 'discount', 'cancellation', 'billing_error', 'other') then
    raise exception 'CREDIT_NOTE_REASON: choose a reason';
  end if;
  if v_today > credit_note_deadline(local_day(v_inv.issued_at)) then
    raise exception 'CREDIT_NOTE_TIME_LIMIT: credit notes against % had to be issued by %',
      v_inv.number, to_char(credit_note_deadline(local_day(v_inv.issued_at)), 'DD Mon YYYY');
  end if;

  if p_lines is not null then
    select coalesce(sum((x ->> 'amount')::numeric), 0) into v_requested
      from jsonb_array_elements(p_lines) x
     where coalesce((x ->> 'amount')::numeric, 0) > 0;
    if v_requested <= 0 then
      raise exception 'CREDIT_NOTE_NOTHING: enter an amount to credit';
    end if;
  end if;

  for v_line, v_idx in
    select value, (ordinality - 1)::int from jsonb_array_elements(v_inv.lines) with ordinality
  loop
    v_total := coalesce((v_line ->> 'total')::numeric, 0);
    continue when v_total <= 0;

    select coalesce(sum((l ->> 'total')::numeric), 0),
           coalesce(sum((l ->> 'net')::numeric), 0),
           coalesce(sum((l ->> 'tax')::numeric), 0)
      into v_cr_total, v_cr_net, v_cr_tax
      from credit_notes c, jsonb_array_elements(c.lines) l
     where c.invoice_id = p_invoice and (l ->> 'line')::int = v_idx;

    v_left := round(v_total - v_cr_total, 2);
    continue when v_left <= 0;

    if p_lines is null then
      v_req := v_left;
    else
      select coalesce(sum((x ->> 'amount')::numeric), 0) into v_req
        from jsonb_array_elements(p_lines) x
       where (x ->> 'line')::int = v_idx;
      v_req := round(v_req, 2);
    end if;
    continue when v_req <= 0;

    if v_req > v_left + 0.005 then
      raise exception 'CREDIT_NOTE_EXCEEDS_LINE: % has only % left to credit',
        coalesce(v_line ->> 'description', 'that line'), v_left;
    end if;

    v_rate := coalesce((v_line ->> 'tax_rate')::numeric, 0);
    if v_req >= v_left then
      -- The rest of the line: take exactly what is left, so the line nets to zero.
      v_net := round(coalesce((v_line ->> 'net')::numeric, 0) - v_cr_net, 2);
      v_tax := round(coalesce((v_line ->> 'tax')::numeric, 0) - v_cr_tax, 2);
      v_req := v_net + v_tax;
    else
      v_net := round(v_req / (1 + v_rate / 100), 2);
      v_tax := round(v_req - v_net, 2);
    end if;

    v_cgst := 0; v_sgst := 0; v_igst := 0;
    if v_inv.tax_regime = 'gst' then
      if v_inv.is_interstate then
        v_igst := v_tax;
      else
        v_cgst := round(v_tax / 2, 2);
        v_sgst := v_tax - v_cgst;
      end if;
    end if;

    v_used := v_used + v_req;
    v_lines := v_lines || jsonb_build_object(
      'line', v_idx,
      'date', v_line ->> 'date',
      'description', coalesce(v_line ->> 'description', ''),
      'sac', coalesce(v_line ->> 'sac', ''),
      'dept', v_line ->> 'dept',
      'rate', v_rate,
      'net', v_net, 'tax', v_tax,
      'cgst', v_cgst, 'sgst', v_sgst, 'igst', v_igst,
      'total', v_req);
  end loop;

  if p_lines is not null and abs(v_used - v_requested) > 0.005 then
    raise exception 'CREDIT_NOTE_BAD_LINE: one of the lines chosen is not on % or has nothing left to credit',
      v_inv.number;
  end if;
  if jsonb_array_length(v_lines) = 0 then
    raise exception 'CREDIT_NOTE_NOTHING: nothing on % is left to credit', v_inv.number;
  end if;

  select credit_note_prefix, invoice_prefix into v_prefix, v_inv_prefix
    from properties where id = v_inv.property_id;
  v_prefix := coalesce(nullif(v_prefix, ''), 'CN');
  if v_prefix = coalesce(nullif(v_inv_prefix, ''), 'INV') then
    raise exception 'CREDIT_NOTE_SERIES: the credit-note prefix must differ from the invoice prefix (Settings)';
  end if;

  v_fy := financial_year_of(v_today);
  insert into invoice_series (property_id, series, financial_year, last_seq)
  values (v_inv.property_id, v_prefix, v_fy, 1)
  on conflict (property_id, series, financial_year)
    do update set last_seq = invoice_series.last_seq + 1
  returning last_seq into v_seq;

  insert into credit_notes (
    property_id, number, series, financial_year, seq,
    invoice_id, booking_id, folio_id, event_id, reason_code, note,
    bill_to_name, bill_to_address, bill_to_gstin, bill_to_state_code, place_of_supply,
    tax_regime, is_interstate, currency,
    net_total, tax_total, cgst_total, sgst_total, igst_total, grand_total,
    tax_breakdown, lines, issued_by
  )
  select
    v_inv.property_id, v_prefix || '/' || v_fy || '/' || lpad(v_seq::text, 4, '0'), v_prefix, v_fy, v_seq,
    v_inv.id, v_inv.booking_id, v_inv.folio_id, v_inv.event_id, p_reason_code, coalesce(btrim(p_note), ''),
    v_inv.bill_to_name, v_inv.bill_to_address, v_inv.bill_to_gstin, v_inv.bill_to_state_code, v_inv.place_of_supply,
    v_inv.tax_regime, v_inv.is_interstate, v_inv.currency,
    sum((l ->> 'net')::numeric), sum((l ->> 'tax')::numeric),
    sum((l ->> 'cgst')::numeric), sum((l ->> 'sgst')::numeric), sum((l ->> 'igst')::numeric),
    sum((l ->> 'total')::numeric),
    (select coalesce(jsonb_agg(b order by b ->> 'sac', (b ->> 'rate')::numeric), '[]')
       from (select jsonb_build_object(
                      'sac', l2 ->> 'sac', 'rate', (l2 ->> 'rate')::numeric,
                      'net', sum((l2 ->> 'net')::numeric), 'tax', sum((l2 ->> 'tax')::numeric),
                      'cgst', sum((l2 ->> 'cgst')::numeric), 'sgst', sum((l2 ->> 'sgst')::numeric),
                      'igst', sum((l2 ->> 'igst')::numeric)) as b
               from jsonb_array_elements(v_lines) l2
              group by l2 ->> 'sac', (l2 ->> 'rate')::numeric) bands),
    v_lines, auth.uid()
  from jsonb_array_elements(v_lines) l
  returning * into v_cn;

  -- The guest owes that much less. An overpaid folio is then refunded through
  -- the usual refund request.
  if v_inv.folio_id is not null then
    insert into folio_entries (property_id, booking_id, folio_id, kind, description, amount, reference,
                               credit_note_id, created_by)
    values (v_inv.property_id, v_inv.booking_id, v_inv.folio_id, 'adjustment',
            'Credit note ' || v_cn.number || ' against ' || v_inv.number,
            v_cn.grand_total, v_cn.number, v_cn.id, auth.uid());
  end if;

  return v_cn;
end;
$$;

revoke execute on function credit_note_issue(uuid, text, text, jsonb) from public, anon;
grant execute on function credit_note_issue(uuid, text, text, jsonb) to authenticated, service_role;

-- An event billed on its own invoice owes less after a credit note too.
create or replace function event_balance(p_event uuid)
returns numeric language sql stable security definer set search_path = public as $$
  select round(
    coalesce((select e.grand_total from event_bookings e where e.id = p_event), 0)
    - coalesce((select sum(case when p.kind = 'refund' then -p.amount else p.amount end)
                  from event_payments p
                 where p.event_id = p_event and p.voided_at is null), 0)
    - coalesce((select sum(c.grand_total) from credit_notes c where c.event_id = p_event), 0), 2);
$$;

-- ── 5. Tax summary, by SAC and rate ─────────────────────────────────────────

drop function if exists report_tax_summary(date, date);
create or replace function report_tax_summary(p_from date, p_to date)
returns table (sac text, rate numeric, net numeric, cgst numeric, sgst numeric, igst numeric, tax numeric, entries int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid := current_property();
  v_p        record;
begin
  if not (has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;

  select tax_regime, sac_fnb, sac_event, sac_other into v_p from properties where id = v_property;

  return query
  with
  -- Charges on folios, by the night or day they belong to.
  folio as (
    select f.sac_code as sac, f.tax_rate as rate, f.amount as net, f.tax_amount as tax,
           0::numeric as igst_part, 1 as n
      from folio_entries f
     where f.voided_at is null
       and f.property_id = v_property
       and f.kind in ('room', 'fee', 'extra', 'penalty')
       and coalesce(f.revenue_dept, '') <> 'paid_out'
       and coalesce(f.stay_date, local_day(f.created_at)) between p_from and p_to
  ),
  -- Allowances against a charge lower its taxable value.
  allowances as (
    select f.sac_code, f.tax_rate, -(f.amount - f.tax_amount), -f.tax_amount, 0::numeric, 1
      from folio_entries f
     where f.voided_at is null
       and f.property_id = v_property
       and f.kind = 'adjustment' and f.applies_to is not null
       and local_day(f.created_at) between p_from and p_to
  ),
  -- Events that carry their own bill (an event charged to a room is already
  -- on that folio).
  events as (
    select v_p.sac_event, (b ->> 'rate')::numeric, (b ->> 'net')::numeric, (b ->> 'tax')::numeric, 0::numeric, 1
      from event_bookings e
      cross join lateral jsonb_array_elements(e.tax_breakdown) b
     where e.status in ('confirmed', 'completed')
       and e.property_id = v_property
       and e.event_date between p_from and p_to
       and not exists (
         select 1 from event_payments p
          where p.event_id = e.id and p.kind = 'room_charge' and p.voided_at is null)
  ),
  -- Outlet bills settled at the outlet. A bill charged to a room went onto
  -- the folio whole (0032), so it is counted there instead.
  outlet_bills as (
    select po.*, o.kind as outlet_kind, o.tax_rate as outlet_rate,
           coalesce(nullif(o.sac_code, ''),
                    case when o.kind in ('restaurant', 'bar', 'room_service', 'mini_bar')
                         then v_p.sac_fnb else v_p.sac_other end) as outlet_sac
      from pos_orders po
      join pos_outlets o on o.id = po.outlet_id
     where po.status = 'settled'
       and po.property_id = v_property
       and local_day(coalesce(po.closed_at, po.opened_at)) between p_from and p_to
       and not exists (
         select 1 from pos_payments pp
          where pp.order_id = po.id and pp.kind = 'room_charge' and pp.voided_at is null)
  ),
  outlets as (
    select ob.outlet_sac, l.tax_rate, l.net_amount, l.tax_amount, 0::numeric, 1
      from outlet_bills ob
      join pos_order_lines l on l.order_id = ob.id and l.voided_at is null
    union all
    select ob.outlet_sac, ob.outlet_rate, ob.service_net, ob.service_tax, 0::numeric, 1
      from outlet_bills ob
     where ob.service_net > 0
  ),
  -- Credit notes reduce the period they are issued in.
  credits as (
    select coalesce(l ->> 'sac', ''), (l ->> 'rate')::numeric,
           -(l ->> 'net')::numeric, -(l ->> 'tax')::numeric, -coalesce((l ->> 'igst')::numeric, 0), 1
      from credit_notes c
      cross join lateral jsonb_array_elements(c.lines) l
     where c.property_id = v_property
       and local_day(c.issued_at) between p_from and p_to
  ),
  all_rows as (
    select * from folio
    union all select * from allowances
    union all select * from events
    union all select * from outlets
    union all select * from credits
  )
  select r.sac::text,
         r.rate,
         round(sum(r.net), 2),
         case when v_p.tax_regime = 'gst' then round(sum(r.tax - r.igst_part) / 2, 2) else 0 end,
         case when v_p.tax_regime = 'gst'
              then round(sum(r.tax - r.igst_part), 2) - round(sum(r.tax - r.igst_part) / 2, 2) else 0 end,
         round(sum(r.igst_part), 2),
         round(sum(r.tax), 2),
         sum(r.n)::int
    from all_rows r
   group by r.sac, r.rate
   order by r.sac, r.rate;
end;
$$;

/*
 * Outlet bills settled at the outlet, by SAC and rate, for the GST register's
 * B2C and SAC summaries. A restaurant bill is a B2C supply in its own right;
 * a bill charged to a room is on that guest's invoice instead.
 */
create or replace function gst_outlet_sales(p_from date, p_to date)
returns table (sac text, rate numeric, net numeric, tax numeric, bills int)
language plpgsql stable security definer set search_path = public as $$
declare
  v_property uuid := current_property();
  v_p        record;
begin
  if not (has_permission('reports.financial') or is_service_role()) then
    raise exception 'not permitted';
  end if;
  select sac_fnb, sac_other into v_p from properties where id = v_property;

  return query
  with bills as (
    select po.id, po.service_net, po.service_tax, o.tax_rate as outlet_rate,
           coalesce(nullif(o.sac_code, ''),
                    case when o.kind in ('restaurant', 'bar', 'room_service', 'mini_bar')
                         then v_p.sac_fnb else v_p.sac_other end) as sac
      from pos_orders po
      join pos_outlets o on o.id = po.outlet_id
     where po.status = 'settled'
       and po.property_id = v_property
       and local_day(coalesce(po.closed_at, po.opened_at)) between p_from and p_to
       and not exists (
         select 1 from pos_payments pp
          where pp.order_id = po.id and pp.kind = 'room_charge' and pp.voided_at is null)
  ),
  rows as (
    select b.id, b.sac, l.tax_rate as rate, l.net_amount as net, l.tax_amount as tax
      from bills b join pos_order_lines l on l.order_id = b.id and l.voided_at is null
    union all
    select b.id, b.sac, b.outlet_rate, b.service_net, b.service_tax from bills b where b.service_net > 0
  )
  select r.sac::text, r.rate, round(sum(r.net), 2), round(sum(r.tax), 2), count(distinct r.id)::int
    from rows r
   group by r.sac, r.rate
   order by r.sac, r.rate;
end;
$$;

-- ── 6. Permission ───────────────────────────────────────────────────────────

-- Whoever may approve a refund may issue a credit note: both give money back.
insert into role_permissions (role_key, permission)
select distinct role_key, 'folio.credit_note'
  from role_permissions
 where permission = 'folio.refund_approve'
on conflict do nothing;
