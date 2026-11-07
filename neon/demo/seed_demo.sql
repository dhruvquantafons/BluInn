-- ============================================================================
-- BluInn demo data — a month in the life of a mid-size Indian hotel.
--
--   psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f neon/demo/seed_demo.sql
--
-- One transaction: it either loads completely or not at all. Every date is
-- relative to "today" in the property's time zone, so the data always spans
-- the last 30 days and the next 30. Run it on a database that has had all
-- migrations applied and has its first administrator (scripts/db-create-admin).
--
-- What it adds is recorded in the schema demo_seed, which is also the marker:
-- a second run refuses, and neon/demo/remove_demo.sql takes exactly those
-- rows away again. Existing rows (the administrator, the property, the seeded
-- masters, any booking or guest already there) are reused, never deleted.
--
-- Demo emails use example.com / example.in only. Demo staff sign in with the
-- password Demo@12345 (see neon/demo/README.md).
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
begin;

-- ── Guard ───────────────────────────────────────────────────────────────────
do $$
begin
  if to_regnamespace('demo_seed') is not null then
    raise exception 'DEMO_ALREADY_SEEDED: the demo data is already loaded (schema demo_seed exists). Run neon/demo/remove_demo.sql first.';
  end if;
  if exists (select 1 from staff where lower(email) = 'rajesh.iyer@example.com') then
    raise exception 'DEMO_ALREADY_SEEDED: demo staff accounts already exist.';
  end if;
  if not exists (select 1 from staff s join roles r on r.key = s.role where r.is_superuser and s.is_active) then
    raise exception 'DEMO_NO_ADMIN: create the first administrator (npm run db:create-admin) before loading demo data.';
  end if;
end $$;

create schema demo_seed;
revoke all on schema demo_seed from public;
comment on schema demo_seed is 'BluInn demo data marker and registry. Drop with neon/demo/remove_demo.sql.';
create table demo_seed.info (key text primary key, val text);
create table demo_seed.ref  (key text primary key, id uuid not null);
create table demo_seed.pre  (tbl text, id text, primary key (tbl, id));
create table demo_seed.rows (tbl text, id text, primary key (tbl, id));

-- Who and where: the first active superuser, working at their own property.
do $$
declare
  v_admin uuid;
  v_prop  uuid;
  v_tz    text;
  t       text;
begin
  select s.id into v_admin
    from staff s join roles r on r.key = s.role
   where r.is_superuser and s.is_active
   order by s.created_at limit 1;
  select coalesce(s.active_property_id, s.property_id) into v_prop from staff s where s.id = v_admin;
  if v_prop is null then
    select id into v_prop from properties where is_default and is_active limit 1;
  end if;
  if v_prop is null then
    select id into v_prop from properties where is_active order by sort_order, name limit 1;
  end if;
  select timezone into v_tz from properties where id = v_prop;

  insert into demo_seed.info values
    ('admin', v_admin::text), ('property', v_prop::text), ('timezone', v_tz),
    ('seeded_at', now()::text),
    ('today', ((now() at time zone v_tz)::date)::text),
    ('audit_max', coalesce((select max(id) from audit_log), 0)::text),
    ('property_before', (select to_jsonb(p) from properties p where id = v_prop)::text),
    ('series_before', coalesce((select jsonb_agg(to_jsonb(s)) from invoice_series s), '[]')::text),
    ('pos_series_before', coalesce((select jsonb_agg(to_jsonb(s)) from pos_order_series s), '[]')::text),
    ('event_series_before', coalesce((select jsonb_agg(to_jsonb(s)) from event_series s), '[]')::text);

  -- Every row that exists now. Whatever is not in here at the end was added
  -- by this script and is recorded in demo_seed.rows for removal.
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tt on tt.table_schema = c.table_schema and tt.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'id' and tt.table_type = 'BASE TABLE'
       and c.table_name not in ('audit_log', 'login_attempts', 'job_runs')
  loop
    execute format('insert into demo_seed.pre select %L, id::text from public.%I', t, t);
  end loop;
  insert into demo_seed.pre select 'auth.users', id::text from auth.users;
end $$;

-- The session runs in the hotel's time zone, so dates and times below are local.
do $$ begin perform set_config('timezone', (select val from demo_seed.info where key = 'timezone'), true); end $$;

-- ── Helpers (temporary: gone when the session ends) ─────────────────────────
create function pg_temp.info(k text) returns text language sql stable as
$$ select val from demo_seed.info where key = k $$;
create function pg_temp.prop() returns uuid language sql stable as
$$ select val::uuid from demo_seed.info where key = 'property' $$;
create function pg_temp.admin() returns uuid language sql stable as
$$ select val::uuid from demo_seed.info where key = 'admin' $$;
create function pg_temp.today() returns date language sql stable as
$$ select val::date from demo_seed.info where key = 'today' $$;

create function pg_temp.ref(k text) returns uuid language plpgsql stable as $$
declare v uuid;
begin
  select id into v from demo_seed.ref where key = k;
  if v is null then raise exception 'DEMO_REF_MISSING: %', k; end if;
  return v;
end $$;
create function pg_temp.ref_or_null(k text) returns uuid language sql stable as
$$ select id from demo_seed.ref where key = k $$;
create function pg_temp.setref(k text, v uuid) returns uuid language sql as $$
  insert into demo_seed.ref values (k, v) on conflict (key) do update set id = excluded.id returning id
$$;

-- Acts as a staff member, the way the app does: auth.uid() reads these claims.
create function pg_temp.act(p uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', p::text, true),
         set_config('request.jwt.claim.role', 'authenticated', true),
         set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
$$;

-- A local time on a day, never later than a minute ago (today's events).
create function pg_temp.ts(d date, t time) returns timestamptz language sql stable as
$$ select least((d + t)::timestamptz, now() - interval '1 minute') $$;

-- Deterministic pseudo-random helpers (setseed below).
create function pg_temp.rnd(lo int, hi int) returns int language sql volatile as
$$ select lo + floor(random() * (hi - lo + 1))::int $$;
create function pg_temp.pick(a text[]) returns text language sql volatile as
$$ select a[1 + floor(random() * cardinality(a))::int] $$;

-- GSTIN check character, as app/lib/gst.ts gstinCheckChar.
create function pg_temp.gstin(p14 text) returns text language plpgsql immutable as $$
declare
  chars text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  s int := 0; v int; prod int;
begin
  for i in 1..14 loop
    v := strpos(chars, substr(p14, i, 1)) - 1;
    prod := v * case when (i - 1) % 2 = 0 then 1 else 2 end;
    s := s + prod / 36 + prod % 36;
  end loop;
  return p14 || substr(chars, ((36 - s % 36) % 36) + 1, 1);
end $$;

create table pg_temp.gst_states (code text primary key, name text);
insert into pg_temp.gst_states values
 ('01','Jammu and Kashmir'),('02','Himachal Pradesh'),('03','Punjab'),('04','Chandigarh'),('05','Uttarakhand'),
 ('06','Haryana'),('07','Delhi'),('08','Rajasthan'),('09','Uttar Pradesh'),('10','Bihar'),('11','Sikkim'),
 ('12','Arunachal Pradesh'),('13','Nagaland'),('14','Manipur'),('15','Mizoram'),('16','Tripura'),('17','Meghalaya'),
 ('18','Assam'),('19','West Bengal'),('20','Jharkhand'),('21','Odisha'),('22','Chhattisgarh'),('23','Madhya Pradesh'),
 ('24','Gujarat'),('26','Dadra and Nagar Haveli and Daman and Diu'),('27','Maharashtra'),('29','Karnataka'),('30','Goa'),
 ('31','Lakshadweep'),('32','Kerala'),('33','Tamil Nadu'),('34','Puducherry'),('35','Andaman and Nicobar Islands'),
 ('36','Telangana'),('37','Andhra Pradesh'),('38','Ladakh'),('97','Other Territory');

-- Room tax by slab on one room-night, as app/lib/tax.ts splitRoomTax.
create function pg_temp.split_room(p numeric, out net numeric, out tax numeric, out rate numeric)
language plpgsql stable as $$
declare
  v_slabs jsonb; v_incl boolean; s record; n numeric;
begin
  select tax_slabs, tax_inclusive into v_slabs, v_incl from properties where id = pg_temp.prop();
  if p <= 0 or v_slabs is null or jsonb_array_length(v_slabs) = 0 then
    net := round(greatest(p, 0), 2); tax := 0; rate := 0; return;
  end if;
  for s in select (e->>'rate')::numeric as r, (e->>'up_to')::numeric as up_to
             from jsonb_array_elements(v_slabs) e order by (e->>'up_to')::numeric nulls last loop
    if not v_incl then
      if s.up_to is null or p <= s.up_to then
        net := round(p, 2); tax := round(p * s.r / 100, 2); rate := s.r; return;
      end if;
    else
      n := p / (1 + s.r / 100);
      if s.up_to is null or n <= s.up_to then
        net := round(n, 2); tax := round(p - round(n, 2), 2); rate := s.r; return;
      end if;
    end if;
    -- remember the top slab for the fallback
    rate := s.r;
  end loop;
  if v_incl then net := round(p / (1 + rate / 100), 2); tax := round(p - net, 2);
  else net := round(p, 2); tax := round(p * rate / 100, 2); end if;
end $$;

-- A fee or penalty that goes with the room takes the room's slab (ancillaryTax).
create function pg_temp.ancillary(p_amount numeric, p_nightly numeric, out net numeric, out tax numeric, out rate numeric)
language plpgsql stable as $$
declare v_incl boolean;
begin
  select tax_inclusive into v_incl from properties where id = pg_temp.prop();
  rate := (pg_temp.split_room(p_nightly)).rate;
  if v_incl then net := round(p_amount / (1 + rate / 100), 2); tax := round(p_amount - net, 2);
  else net := round(p_amount, 2); tax := round(p_amount * rate / 100, 2); end if;
end $$;

-- Nightly rates for a stay, as app/lib/pricing.ts quoteStay (seasons, plan,
-- length-of-stay discount, extra adults; rounded to the rupee).
create function pg_temp.quote(p_type uuid, p_plan uuid, p_ci date, p_co date, p_adults int default 2, p_rooms int default 1)
returns jsonb language plpgsql stable as $$
declare
  rt room_types; pl rate_plans; s rate_seasons;
  d date; base numeric; r numeric; los int := p_co - p_ci; los_disc numeric := 0;
  extra_adult numeric; extra_n int; out jsonb := '[]';
begin
  select * into rt from room_types where id = p_type;
  select * into pl from rate_plans where id = p_plan;
  select coalesce((select amount from extra_charges where kind = 'extra_adult' and is_active
                    and property_id = pg_temp.prop() order by sort_order limit 1), 0) into extra_adult;
  extra_n := greatest(0, ceil(greatest(1, p_adults)::numeric / greatest(1, p_rooms))::int - rt.base_occupancy);
  if pl.id is not null and pl.los_discount_min_nights is not null and pl.los_discount_percent is not null
     and los >= pl.los_discount_min_nights then
    los_disc := pl.los_discount_percent;
  end if;
  for d in select generate_series(p_ci, p_co - 1, interval '1 day')::date loop
    base := case when extract(dow from d) in (5, 6) and rt.weekend_rate is not null then rt.weekend_rate else rt.base_rate end;
    select * into s from rate_seasons x
     where x.is_active and x.start_date <= d and x.end_date >= d
       and (x.room_type_id is null or x.room_type_id = p_type)
       and extract(dow from d)::int = any (x.days_of_week)
       and x.property_id = rt.property_id
     order by x.priority desc, (x.room_type_id is not null) desc, x.created_at desc
     limit 1;
    r := base;
    if s.id is not null then
      r := case s.adjustment_kind when 'fixed' then s.adjustment_value when 'amount' then r + s.adjustment_value
                else r * (1 + s.adjustment_value / 100) end;
    end if;
    if pl.id is not null then
      r := case pl.adjustment_kind when 'fixed' then pl.adjustment_value when 'amount' then r + pl.adjustment_value
                else r * (1 + pl.adjustment_value / 100) end;
    end if;
    r := r * (1 - los_disc / 100) + extra_n * extra_adult;
    out := out || jsonb_build_object('date', d, 'rate', greatest(0, round(r)));
  end loop;
  return out;
end $$;

create function pg_temp.nightly(p_booking uuid, p_night date) returns numeric language sql stable as $$
  select coalesce((select (n->>'rate')::numeric from bookings b, jsonb_array_elements(b.rate_breakdown) n
                    where b.id = p_booking and n->>'date' = p_night::text limit 1),
                  (select quoted_rate from bookings where id = p_booking), 0)
$$;

-- One folio line, written the way the app writes it, at a given moment.
create function pg_temp.post(
  p_booking uuid, p_kind text, p_desc text, p_amount numeric, p_at timestamptz, p_by uuid,
  p_tax numeric default 0, p_rate numeric default 0, p_stay date default null,
  p_method payment_method default null, p_ref text default '', p_deposit boolean default false,
  p_folio uuid default null, p_audit date default null,
  p_fx text default null, p_fx_amount numeric default null, p_fx_rate numeric default null,
  p_applies uuid default null)
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into folio_entries (booking_id, folio_id, kind, description, stay_date, amount, tax_amount, tax_rate,
                             method, reference, is_deposit, night_audit_date, created_by, created_at,
                             fx_currency, fx_amount, fx_rate, applies_to)
  values (p_booking, p_folio, p_kind, p_desc, p_stay, round(p_amount, 2), round(p_tax, 2), p_rate,
          p_method, coalesce(p_ref, ''), p_deposit, p_audit, p_by, p_at, p_fx, p_fx_amount, p_fx_rate, p_applies)
  returning id into v;
  return v;
end $$;

-- Night audit's room charge for one night (app/lib/folio.ts postRoomCharges).
create function pg_temp.post_night(p_booking uuid, p_night date, p_at timestamptz, p_by uuid,
                                   p_audit date default null, p_folio uuid default null)
returns uuid language plpgsql as $$
declare
  b record; v_rate numeric; s record; v_comp boolean;
begin
  select bk.*, r.room_number into b from bookings bk left join rooms r on r.id = bk.room_id where bk.id = p_booking;
  v_comp := b.stay_type <> 'paid';
  v_rate := case when v_comp then 0 else pg_temp.nightly(p_booking, p_night) end;
  s := pg_temp.split_room(v_rate);
  return pg_temp.post(p_booking, 'room',
    coalesce('Room ' || b.room_number, 'Room') || ' — night of ' || p_night
      || case when b.rooms_count > 1 then ' × ' || b.rooms_count else '' end
      || case when v_comp then case when b.stay_type = 'house_use' then ' (house use)' else ' (complimentary)' end else '' end,
    round(s.net * b.rooms_count, 2), p_at, p_by, round(s.tax * b.rooms_count, 2), s.rate, p_night,
    null, '', false, p_folio, p_audit);
end $$;

-- A folio's tax invoice, as app/lib/invoice-issue.ts issueFolioInvoice with
-- app/lib/invoices.ts (lines, rate-wise bands, CGST/SGST split) and
-- app/lib/gst.ts invoiceTaxFields. The number comes from next_invoice_number.
create function pg_temp.issue_invoice(p_folio uuid, p_name text, p_gstin text, p_address text,
                                      p_at timestamptz, p_by uuid)
returns uuid language plpgsql as $$
declare
  p properties; f folios; v_regime text; v_lines jsonb; v_net numeric; v_tax numeric; v_grand numeric;
  v_bands jsonb; v_fy text; v_seq int; v_prefix text; v_state text; v_id uuid; v_fx record;
  v_cgst numeric; v_sgst numeric;
begin
  select * into p from properties where id = pg_temp.prop();
  select * into f from folios where id = p_folio;
  if exists (select 1 from invoices where folio_id = p_folio and status = 'issued') then return null; end if;
  v_regime := coalesce(p.tax_regime, 'gst');

  with live as (
    select e.*, row_number() over (order by e.created_at, e.id) as n
      from folio_entries e where e.folio_id = p_folio and e.voided_at is null
  ), charges as (
    select n, jsonb_build_object(
             'date', coalesce(stay_date, (created_at at time zone p.timezone)::date)::text,
             'description', coalesce(nullif(description, ''), kind),
             'kind', kind,
             'net', round(amount, 2), 'tax_rate', tax_rate, 'tax', round(tax_amount, 2),
             'total', round(amount + tax_amount, 2), 'sac', coalesce(sac_code, ''), 'dept', revenue_dept) as l
      from live where kind in ('room', 'fee', 'penalty', 'extra')
  ), allowances as (
    select 100000 + n as n, jsonb_build_object(
             'date', ((created_at at time zone p.timezone)::date)::text,
             'description', 'Allowance: ' || coalesce(nullif(description, ''), 'discount'),
             'kind', 'allowance',
             'net', -round(amount - tax_amount, 2), 'tax_rate', tax_rate, 'tax', -round(tax_amount, 2),
             'total', -round(amount, 2), 'sac', coalesce(sac_code, ''), 'dept', revenue_dept) as l
      from live where kind = 'adjustment' and applies_to is not null
  ), all_lines as (select * from charges union all select * from allowances)
  select coalesce(jsonb_agg(
           case when v_regime = 'gst'
                then l || jsonb_build_object('cgst', round((l->>'tax')::numeric / 2, 2),
                                             'sgst', round((l->>'tax')::numeric - round((l->>'tax')::numeric / 2, 2), 2),
                                             'igst', 0)
                else l - 'sac' end order by n), '[]')
    into v_lines from all_lines;

  if jsonb_array_length(v_lines) = 0 then return null; end if;
  select round(sum((l->>'net')::numeric), 2), round(sum((l->>'tax')::numeric), 2),
         round(coalesce(sum((l->>'cgst')::numeric), 0), 2), round(coalesce(sum((l->>'sgst')::numeric), 0), 2)
    into v_net, v_tax, v_cgst, v_sgst from jsonb_array_elements(v_lines) l;
  v_grand := round(v_net + v_tax, 2);

  select coalesce(jsonb_agg(b order by b->>'sac', (b->>'rate')::numeric), '[]') into v_bands
    from (select jsonb_strip_nulls(jsonb_build_object(
                   'rate', (l->>'tax_rate')::numeric,
                   'net', round(sum((l->>'net')::numeric), 2), 'tax', round(sum((l->>'tax')::numeric), 2),
                   'sac', l->>'sac',
                   'cgst', case when v_regime = 'gst' then round(sum((l->>'cgst')::numeric), 2) end,
                   'sgst', case when v_regime = 'gst' then round(sum((l->>'sgst')::numeric), 2) end,
                   'igst', case when v_regime = 'gst' then 0 end)) as b
            from jsonb_array_elements(v_lines) l
           group by l->>'sac', (l->>'tax_rate')::numeric
          having round(sum((l->>'net')::numeric), 2) <> 0 or round(sum((l->>'tax')::numeric), 2) <> 0) x;

  v_prefix := coalesce(nullif(p.invoice_prefix, ''), 'INV');
  v_fy := financial_year_of((p_at at time zone p.timezone)::date);
  v_seq := next_invoice_number(v_prefix, v_fy);
  v_state := coalesce(nullif(p.gst_state_code, ''), left(p.gstin, 2));
  select fx_currency, fx_rate into v_fx from folio_entries
   where folio_id = p_folio and voided_at is null and kind = 'payment' and fx_currency is not null
   order by created_at limit 1;

  insert into invoices (number, series, financial_year, seq, booking_id, folio_id,
                        bill_to_name, bill_to_address, bill_to_gstin, bill_to_state_code, place_of_supply,
                        tax_regime, supplier_gstin, supplier_state_code, is_interstate, currency,
                        net_total, tax_total, grand_total, cgst_total, sgst_total, igst_total,
                        tax_breakdown, lines, fx_currency, fx_rate, issued_at, issued_by)
  values (v_prefix || '/' || v_fy || '/' || lpad(v_seq::text, 4, '0'), v_prefix, v_fy, v_seq, f.booking_id, p_folio,
          btrim(p_name), btrim(coalesce(p_address, '')), upper(coalesce(p_gstin, '')),
          case when v_regime = 'gst' and coalesce(p_gstin, '') <> '' then left(upper(p_gstin), 2) else '' end,
          case when v_regime = 'gst' then v_state || ' – ' || coalesce((select name from pg_temp.gst_states where code = v_state), '')
               else p.state end,
          v_regime, case when v_regime = 'gst' then upper(p.gstin) else p.gstin end,
          case when v_regime = 'gst' then v_state else '' end, false, p.currency,
          v_net, v_tax, v_grand,
          case when v_regime = 'gst' then v_cgst else 0 end, case when v_regime = 'gst' then v_sgst else 0 end, 0,
          v_bands, v_lines, v_fx.fx_currency, v_fx.fx_rate, p_at, p_by)
  returning id into v_id;
  -- The loyalty trigger awarded points just now; date them with the invoice.
  update loyalty_transactions set created_at = p_at where invoice_id = v_id;
  return v_id;
end $$;

-- Who is at the desk at a given moment (front desk rota, night auditor).
create function pg_temp.desk(p_at timestamptz) returns uuid language sql stable as $$
  select case
    when extract(hour from p_at) >= 23 or extract(hour from p_at) < 7 then pg_temp.ref('staff:vikram')
    when extract(hour from p_at) < 15 then
      case when extract(week from p_at)::int % 2 = 0 then pg_temp.ref('staff:ankit') else pg_temp.ref('staff:sneha') end
    else
      case when extract(week from p_at)::int % 2 = 0 then pg_temp.ref('staff:sneha') else pg_temp.ref('staff:ankit') end
  end
$$;

-- An outlet bill at a given moment (pos_open_order, pos_add_line, then
-- pos_take_payment or pos_charge_to_room, written with the bill's own times).
create function pg_temp.pos_bill(p_outlet text, p_at timestamptz, p_items text[], p_qty numeric[],
                                 p_pay text, p_booking uuid default null, p_table text default '',
                                 p_covers int default 1, p_guest text default '', p_by uuid default null)
returns uuid language plpgsql as $$
declare
  o pos_outlets; v_order uuid; v_number text; v_item uuid; i int; v_closed timestamptz;
  b record; v_folio uuid; v_band record; v_label text; ord pos_orders; v_by uuid; v_loc uuid; v_owing numeric;
begin
  v_by := coalesce(p_by, pg_temp.admin());
  select * into o from pos_outlets where code = p_outlet and property_id = pg_temp.prop();
  v_number := o.code || '/' || lpad(next_pos_order_number(o.id)::text, 6, '0');
  select null::uuid as room_id, null::text as gname, null::text as reference into b;
  if p_booking is not null then
    select bk.room_id, g.full_name as gname, bk.reference into b
      from bookings bk left join guests g on g.id = bk.guest_id left join rooms r on r.id = bk.room_id
     where bk.id = p_booking;
  end if;
  insert into pos_orders (number, outlet_id, table_no, room_id, booking_id, guest_name, covers, opened_by, opened_at)
  values (v_number, o.id, coalesce(p_table, ''), b.room_id, p_booking,
          coalesce(nullif(p_guest, ''), b.gname, ''), greatest(p_covers, 1), v_by, p_at)
  returning id into v_order;
  for i in 1..cardinality(p_items) loop
    select id into v_item from pos_items where outlet_id = o.id and name = p_items[i];
    if v_item is null then raise exception 'DEMO_POS_ITEM: % at %', p_items[i], p_outlet; end if;
    perform pos_add_line(v_order, v_item, p_qty[i]);
  end loop;
  update pos_order_lines set created_at = p_at, created_by = v_by,
         kot_sent_at = case when o.sends_kot then p_at + interval '3 minutes' end
   where order_id = v_order;

  if p_pay is null then return v_order; end if;  -- left open
  select * into ord from pos_orders where id = v_order;
  v_closed := p_at + make_interval(mins => case o.kind when 'restaurant' then 55 when 'bar' then 70
                                                         when 'spa' then 75 else 15 end);
  v_closed := least(v_closed, now() - interval '1 minute');

  if p_pay = 'room' then
    v_folio := master_folio(p_booking);
    v_label := o.name || ' — ' || v_number;
    for v_band in select tax_rate, sum(net_amount) as net, sum(tax_amount) as tax
                    from pos_order_lines where order_id = v_order and voided_at is null
                   group by tax_rate having sum(net_amount) + sum(tax_amount) > 0 order by tax_rate loop
      perform pg_temp.post(p_booking, 'extra', v_label, v_band.net, v_closed, v_by, v_band.tax, v_band.tax_rate,
                           null, null, v_number, false, v_folio);
    end loop;
    if ord.service_net > 0 then
      perform pg_temp.post(p_booking, 'extra', v_label || ' — service charge', ord.service_net, v_closed, v_by,
                           ord.service_tax, o.tax_rate, null, null, v_number, false, v_folio);
    end if;
    insert into pos_payments (order_id, kind, amount, booking_id, folio_id, reference, created_by, created_at)
    values (v_order, 'room_charge', ord.grand_total, p_booking, v_folio, coalesce(b.reference, ''), v_by, v_closed);
  else
    insert into pos_payments (order_id, kind, amount, reference, created_by, created_at)
    values (v_order, p_pay, ord.grand_total, case when p_pay in ('card', 'upi') then upper(p_pay) || '-' || pg_temp.rnd(100000, 999999) else '' end,
            v_by, v_closed);
  end if;
  update pos_orders set status = 'settled', closed_at = v_closed where id = v_order;

  -- Stock sold from an outlet's store, as inventory_consume_pos would record it.
  select id into v_loc from inventory_locations where outlet_id = o.id and is_active;
  if v_loc is not null then
    insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by, created_at)
    select m.inv_item, v_loc, 'consume', -sum(l.qty), ii.unit_cost, 'Sold', v_number, v_by, v_closed
      from pos_order_lines l join pg_temp.inv_pos m on m.pos_item = l.item_id
      join inventory_items ii on ii.id = m.inv_item
     where l.order_id = v_order and l.voided_at is null
     group by m.inv_item, ii.unit_cost;
  end if;
  return v_order;
end $$;

-- Closes a business day the way runNightAudit does: stamps the day's folio
-- lines (close_folio_day) and stores the daily revenue report.
create function pg_temp.close_day(d date) returns void language plpgsql as $$
declare
  v_prop uuid := pg_temp.prop(); v_by uuid := pg_temp.ref('staff:vikram');
  v_report jsonb; v_avail int; v_sold int; v_comp int; v_room numeric;
  sum_k numeric; tax_k numeric;
begin
  if exists (select 1 from night_audits where property_id = v_prop and business_date = d) then return; end if;
  update folio_entries set night_audit_date = d
   where night_audit_date is null and property_id = v_prop and created_at < (d + 1)::timestamptz;

  select count(*) into v_avail from rooms where property_id = v_prop and status <> 'out_of_service';
  select coalesce(sum(rooms_count) filter (where stay_type = 'paid'), 0), coalesce(sum(rooms_count) filter (where stay_type <> 'paid'), 0)
    into v_sold, v_comp
    from bookings where property_id = v_prop and status in ('checked_in', 'checked_out')
     and check_in <= d and check_out > d and checked_in_at < (d + 1)::timestamptz;
  select coalesce(sum(amount) filter (where kind = 'room'), 0),
         coalesce(sum(amount) filter (where kind in ('room', 'fee', 'extra', 'penalty')), 0),
         coalesce(sum(tax_amount) filter (where kind in ('room', 'fee', 'extra', 'penalty')), 0)
    into v_room, sum_k, tax_k
    from folio_entries where property_id = v_prop and night_audit_date = d and voided_at is null;

  v_report := jsonb_build_object(
    'business_date', d,
    'rooms', jsonb_build_object('available', v_avail, 'sold', v_sold, 'complimentary', v_comp,
             'occupancy_percent', case when v_avail > 0 then round(v_sold * 1000.0 / v_avail) / 10 else 0 end),
    'revenue', (select jsonb_build_object(
                  'room', v_room,
                  'fees', coalesce(sum(amount) filter (where kind = 'fee'), 0),
                  'extras', coalesce(sum(amount) filter (where kind = 'extra'), 0),
                  'penalties', coalesce(sum(amount) filter (where kind = 'penalty'), 0),
                  'tax', tax_k, 'total', round(sum_k + tax_k, 2))
                  from folio_entries where property_id = v_prop and night_audit_date = d and voided_at is null),
    'kpis', jsonb_build_object('adr', case when v_sold > 0 then round(v_room / v_sold, 2) else 0 end,
                               'revpar', case when v_avail > 0 then round(v_room / v_avail, 2) else 0 end),
    'payments', (select jsonb_build_object(
                   'by_method', coalesce((select jsonb_object_agg(m, t) from (
                       select coalesce(method::text, 'other') m, round(sum(case when kind = 'refund' then -amount else amount end), 2) t
                         from folio_entries where property_id = v_prop and night_audit_date = d and voided_at is null
                          and kind in ('payment', 'refund') group by 1) x), '{}'),
                   'by_cashier', coalesce((select jsonb_object_agg(w, t) from (
                       select coalesce(nullif(s.full_name, ''), s.email, 'System') w,
                              round(sum(case when e.kind = 'refund' then -e.amount else e.amount end), 2) t
                         from folio_entries e left join staff s on s.id = e.created_by
                        where e.property_id = v_prop and e.night_audit_date = d and e.voided_at is null
                          and e.kind in ('payment', 'refund') group by 1) x), '{}'),
                   'total', coalesce((select round(sum(case when kind = 'refund' then -amount else amount end), 2)
                         from folio_entries where property_id = v_prop and night_audit_date = d and voided_at is null
                          and kind in ('payment', 'refund')), 0))),
    'movements', jsonb_build_object(
       'arrivals', (select count(*) from bookings where property_id = v_prop and check_in = d and status in ('checked_in', 'checked_out')),
       'departures', (select count(*) from bookings where property_id = v_prop and check_out = d and status = 'checked_out'),
       'cancellations', (select count(*) from bookings where property_id = v_prop and status = 'cancelled'
                          and cancelled_at >= d::timestamptz and cancelled_at < (d + 1)::timestamptz),
       'no_shows', coalesce((select jsonb_agg(jsonb_build_object('reference', reference, 'guest', contact_name, 'penalty', coalesce(penalty_amount, 0)))
                      from bookings where property_id = v_prop and status = 'no_show' and check_in = d), '[]'),
       'expired_holds', '[]'::jsonb, 'pending_arrivals_left', '[]'::jsonb),
    'exceptions', jsonb_build_object('overstays', '[]'::jsonb),
    'housekeeping', jsonb_build_object('room_statuses_updated', 0, 'tasks_created', 0),
    'maintenance', jsonb_build_object('preventive_created', 0, 'escalated', 0),
    'compliance', jsonb_build_object('id_documents_purged', 0),
    'loyalty', jsonb_build_object('points_expired', 0,
                 'tiers_reviewed', (select count(*) from guests where property_id = v_prop and loyalty_opt_in)),
    'outlets', (select jsonb_build_object(
                  'bills', count(*), 'total', coalesce(round(sum(o.grand_total), 2), 0),
                  'by_outlet', coalesce((select jsonb_object_agg(n, t) from (
                      select ou.name n, round(sum(po.grand_total), 2) t from pos_orders po join pos_outlets ou on ou.id = po.outlet_id
                       where po.property_id = v_prop and po.status = 'settled'
                         and po.closed_at >= d::timestamptz and po.closed_at < (d + 1)::timestamptz group by 1) x), '{}'),
                  'by_method', coalesce((select jsonb_object_agg(k, t) from (
                      select pp.kind k, round(sum(pp.amount), 2) t from pos_payments pp join pos_orders po on po.id = pp.order_id
                       where po.property_id = v_prop and po.status = 'settled' and pp.voided_at is null
                         and po.closed_at >= d::timestamptz and po.closed_at < (d + 1)::timestamptz group by 1) x), '{}'))
                  from pos_orders o where o.property_id = v_prop and o.status = 'settled'
                   and o.closed_at >= d::timestamptz and o.closed_at < (d + 1)::timestamptz),
    'posted_room_charges', (select count(*) from folio_entries where property_id = v_prop and kind = 'room'
                              and night_audit_date = d and stay_date = d));

  insert into night_audits (property_id, business_date, status, started_by, started_at, completed_at, report, error)
  values (v_prop, d, 'completed', v_by, (d + time '23:45')::timestamptz, (d + time '23:52')::timestamptz, v_report, '');
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Masters
-- ════════════════════════════════════════════════════════════════════════════
do $$ begin perform pg_temp.act(pg_temp.admin()); perform setseed(0.4242); end $$;

-- ── Property: fill blanks only; never renamed ───────────────────────────────
do $$
declare p properties; v_code text; v_state text;
begin
  select * into p from properties where id = pg_temp.prop();
  v_code := coalesce(nullif(p.gst_state_code, ''),
                     nullif(left(p.gstin, 2), ''),
                     (select code from pg_temp.gst_states where lower(name) = lower(btrim(p.state))),
                     '27');
  v_state := coalesce(nullif(p.state, ''), (select name from pg_temp.gst_states where code = v_code), 'Maharashtra');
  update properties set
    legal_name     = coalesce(nullif(legal_name, ''), name || ' Hospitality Pvt Ltd'),
    address        = coalesce(nullif(address, ''), '14, Lake Road, Near City Centre'),
    city           = coalesce(nullif(city, ''), case v_code when '27' then 'Pune' when '24' then 'Ahmedabad' when '29' then 'Bengaluru'
                                                          when '07' then 'New Delhi' when '33' then 'Chennai' when '36' then 'Hyderabad'
                                                          when '08' then 'Jaipur' when '30' then 'Panaji' else 'Pune' end),
    state          = v_state,
    postcode       = coalesce(nullif(postcode, ''), '411001'),
    phone          = coalesce(nullif(phone, ''), '+91 20 4000 1234'),
    email          = coalesce(nullif(email, ''), 'reservations@example.in'),
    gst_state_code = v_code,
    gstin          = coalesce(nullif(gstin, ''), pg_temp.gstin(v_code || 'AAFCB7319Q1Z')),
    loyalty_enabled = true,
    hr_geofence_lat = coalesce(hr_geofence_lat, 18.520430), hr_geofence_lng = coalesce(hr_geofence_lng, 73.856743)
  where id = p.id;
end $$;

-- ── Room types: the two that exist, plus Classic (5% slab) and a suite ──────
do $$
declare v_a uuid; v_b uuid; v_c uuid; v_s uuid;
begin
  select id into v_a from room_types where property_id = pg_temp.prop() order by sort_order, base_rate limit 1;
  select id into v_b from room_types where property_id = pg_temp.prop() and id <> v_a order by sort_order, base_rate limit 1;
  if v_b is null then v_b := v_a; end if;
  perform pg_temp.setref('rt:a', v_a), pg_temp.setref('rt:b', v_b);

  insert into room_types (slug, name, category, tagline, description, size, occupancy, view, base_rate, weekend_rate,
                          max_adults, max_children, base_occupancy, highlights, amenities, sort_order, cleaning_minutes)
  values ('classic-room', 'Classic Room', 'classic', 'Smart, quiet and great value',
          'A well-appointed room for business and short leisure stays, with a work desk and rain shower.',
          '240 sq ft', '2 adults', 'City', 5999, 6499, 2, 1, 2,
          '{Queen bed,Work desk,Rain shower}', '{Wi-Fi,LED TV,Tea & coffee maker,Mini-bar,Safe}', 0, 25)
  returning id into v_c;
  insert into room_types (slug, name, category, tagline, description, size, occupancy, view, base_rate, weekend_rate,
                          max_adults, max_children, base_occupancy, highlights, amenities, sort_order, cleaning_minutes)
  values ('executive-suite', 'Executive Suite', 'suite', 'Separate living room and lake views',
          'Our top-floor suites with a separate living area, bathtub and butler service on request.',
          '620 sq ft', '3 adults', 'Lake', 15999, 17499, 3, 2, 2,
          '{King bed,Living room,Bathtub,Lake view}', '{Wi-Fi,Two LED TVs,Espresso machine,Mini-bar,Safe,Bathtub}', 9, 50)
  returning id into v_s;
  perform pg_temp.setref('rt:classic', v_c), pg_temp.setref('rt:suite', v_s);
end $$;

-- ── Rooms: 30 over four floors ──────────────────────────────────────────────
insert into rooms (room_number, room_type_id, floor, view, bed_configuration, is_smoking, is_accessible, housekeeping_status, last_deep_clean_on)
select n::text, pg_temp.ref(t), f, v, bed, false, n in (101, 201), 'inspected', pg_temp.today() - (n % 25)
  from (select g as n, 1 as f, 'rt:classic' as t, 'City' as v, case when g % 2 = 0 then 'Twin' else 'Queen' end as bed from generate_series(101, 108) g
        union all select g, 2, 'rt:a', case when g <= 205 then 'Garden' else 'City' end, case when g % 3 = 0 then 'Twin' else 'King' end from generate_series(201, 210) g
        union all select g, 3, 'rt:b', 'Lake', 'King' from generate_series(301, 308) g
        union all select g, 4, 'rt:suite', 'Lake', 'King' from generate_series(401, 404) g) x;
insert into demo_seed.ref select 'room:' || room_number, id from rooms where property_id = pg_temp.prop()
  and id::text not in (select id from demo_seed.pre where tbl = 'rooms');
update rooms set connecting_room_id = pg_temp.ref('room:202') where id = pg_temp.ref('room:201');
update rooms set connecting_room_id = pg_temp.ref('room:201') where id = pg_temp.ref('room:202');

-- ── Companies (B2B, city ledger) ────────────────────────────────────────────
insert into companies (name, gstin, contact_name, email, phone, billing_address, credit_limit, payment_terms_days, notes)
values
 ('Zenith Infotech Pvt Ltd', pg_temp.gstin('29AABCZ4821K1Z'), 'Lakshmi Narayan', 'travel.desk@zenith.example.com', '+91 80 4123 5500',
  '4th Floor, Tech Park One, Outer Ring Road, Bengaluru, Karnataka 560103', 500000, 30, 'Monthly billing. Room and tax to company; incidentals by guest.'),
 ('Meridian Pharma Ltd', pg_temp.gstin('24AAECM5530H1Z'), 'Hetal Parikh', 'admin@meridianpharma.example.in', '+91 79 2658 1100',
  'Meridian House, SG Highway, Ahmedabad, Gujarat 380054', 300000, 21, 'Regional sales meets twice a year.'),
 ('Coastal Logistics LLP', pg_temp.gstin('27AANFC2207M1Z'), 'Sanjay Kamath', 'accounts@coastal.example.com', '+91 22 6612 0400',
  'Unit 12, Logistics Hub, Bhiwandi, Maharashtra 421302', 150000, 30, ''),
 ('Northstar Consulting', pg_temp.gstin('07AAHFN9012P1Z'), 'Ritika Bhalla', 'ops@northstar.example.com', '+91 11 4050 7788',
  '22 Barakhamba Road, Connaught Place, New Delhi, Delhi 110001', null, 15, 'Pays by bank transfer within 15 days.');
insert into demo_seed.ref select 'co:' || split_part(lower(name), ' ', 1), id from companies
 where property_id = pg_temp.prop() and id::text not in (select id from demo_seed.pre where tbl = 'companies');

-- ── Rate plans, packages, seasons, restrictions, allocations ────────────────
do $$
declare v_bar uuid; v_rom uuid; v_map uuid; T date := pg_temp.today();
begin
  select id into v_bar from rate_plans where property_id = pg_temp.prop() order by (code = 'BAR') desc, sort_order limit 1;
  perform pg_temp.setref('plan:bar', v_bar);
  insert into rate_plans (code, name, rate_type, description, meal_plan, adjustment_kind, adjustment_value,
                          inclusions, is_refundable, free_cancellation_hours, cancellation_penalty, no_show_penalty,
                          deposit_percent, min_los, los_discount_min_nights, los_discount_percent, is_public, sort_order, company_id)
  values
   ('CORP', 'Corporate Rate', 'corporate', 'Negotiated rate for contracted companies. Breakfast and Wi-Fi included.',
    'CP', 'percent', -12, '{Breakfast,Wi-Fi,Airport drop at cost}', true, 24, 'first_night', 'first_night', 0, null, null, null, false, 2, null),
   ('NRF', 'Advance Purchase — Non-refundable', 'promotional', 'Pay in full at booking and save 15%.',
    'CP', 'percent', -15, '{Breakfast}', false, 0, 'full_stay', 'full_stay', 100, null, null, null, true, 3, null),
   ('STAY3', 'Stay 3, Save 15%', 'promotional', 'Stay three nights or more and the whole stay is 15% off.',
    'CP', 'percent', 0, '{Breakfast}', true, 48, 'first_night', 'first_night', 0, 3, 3, 15, true, 4, null),
   ('GRP', 'Group Rate', 'group', 'Rooming-list rate for groups of five rooms or more.',
    'CP', 'percent', -18, '{Breakfast,Welcome drink}', true, 168, 'first_night', 'first_night', 25, null, null, null, false, 5, null);
  insert into rate_plans (code, name, rate_type, description, meal_plan, adjustment_kind, adjustment_value, inclusions, deposit_percent, sort_order)
  values ('MAP', 'Breakfast & Dinner', 'package', 'Buffet breakfast and dinner at the Main Restaurant.', 'MAP', 'amount', 1800,
          '{Breakfast,Dinner}', 0, 6) returning id into v_map;
  insert into rate_plans (code, name, rate_type, description, meal_plan, adjustment_kind, adjustment_value, inclusions,
                          deposit_percent, min_los, room_type_ids, sort_order)
  values ('ROMANCE', 'Romantic Getaway', 'package', 'Candle-light dinner, couples spa and a late check-out.', 'MAP', 'amount', 4500,
          '{Breakfast,Candle-light dinner,Couples spa,Late check-out}', 30, 1,
          array[pg_temp.ref('rt:b'), pg_temp.ref('rt:suite')], 7) returning id into v_rom;
  insert into demo_seed.ref select 'plan:' || lower(code), id from rate_plans
   where property_id = pg_temp.prop() and id::text not in (select id from demo_seed.pre where tbl = 'rate_plans');

  insert into package_components (rate_plan_id, name, description, retail_value, basis, quantity, sort_order) values
   (v_rom, 'Candle-light dinner for two', 'Four-course set menu at the poolside deck', 4200, 'per_stay', 1, 1),
   (v_rom, 'Couples Balinese massage', '90 minutes at the spa', 7800, 'per_stay', 1, 2),
   (v_rom, 'Cake and flowers on arrival', '', 1500, 'per_stay', 1, 3),
   (v_rom, 'Late check-out until 3 pm', 'Subject to availability', 0, 'per_stay', 1, 4),
   (v_map, 'Buffet dinner', 'Main Restaurant, 7.30–11 pm', 1470, 'per_night', 2, 1);

  insert into rate_seasons (name, start_date, end_date, room_type_id, days_of_week, adjustment_kind, adjustment_value, priority) values
   ('Weekend premium', T - 120, T + 240, null, '{5,6}', 'percent', 8, 0),
   ('Festive week', T - 3, T + 4, null, '{0,1,2,3,4,5,6}', 'percent', 10, 2),
   ('Wedding season', T + 10, T + 75, null, '{0,1,2,3,4,5,6}', 'percent', 12, 1),
   ('Monsoon saver', T - 150, T - 60, null, '{0,1,2,3,4}', 'percent', -15, 1),
   ('Suite New Year', T + 52, T + 56, pg_temp.ref('rt:suite'), '{0,1,2,3,4,5,6}', 'fixed', 24999, 3);

  insert into rate_restrictions (start_date, end_date, room_type_id, rate_plan_id, min_los, closed_to_arrival, stop_sell, note) values
   (T + 53, T + 55, null, null, 2, false, false, 'Year-end: minimum two nights'),
   (T + 13, T + 13, null, null, null, true, false, 'Wedding group arrival day — closed to other arrivals'),
   (T + 20, T + 21, pg_temp.ref('rt:suite'), null, null, false, true, 'Suite floor carpet replacement'),
   (T + 1, T + 30, null, pg_temp.ref('plan:nrf'), null, false, false, 'Advance purchase on sale');

  insert into channel_allocations (room_type_id, source, rooms)
  select pg_temp.ref(rtk), src::booking_source, cnt
    from (values ('rt:classic', 'ota', 3), ('rt:classic', 'travel_agent', 1), ('rt:a', 'ota', 3), ('rt:a', 'corporate', 3),
                 ('rt:b', 'ota', 2), ('rt:b', 'travel_agent', 1), ('rt:suite', 'ota', 1)) x (rtk, src, cnt)
  on conflict (room_type_id, source) do nothing;
end $$;

-- ── Staff (15) ──────────────────────────────────────────────────────────────
do $$
declare r record; v uuid; v_prop uuid := pg_temp.prop();
begin
  for r in select * from (values
    ('rajesh', 'Rajesh Iyer', 'manager', 'General Manager', 'Management', 'Morning', 6, 'EMP-001', '1978-04-12', 'B+', 'scrypt$16384$8$1$mRMkj2nxSpHvtoGbOD1taQ==$BREzy2xqlPqXD6Pysqh0oWtH9GZElWXQhidYzGNKT2zVlrlDSRivKlNca0QfEUX+Kkw8i9RmxlDegvB0aaikIg=='),
    ('priya', 'Priya Nair', 'front_office_manager', 'Front Office Manager', 'Front Office', 'Morning', 6, 'EMP-002', '1986-09-03', 'O+', 'scrypt$16384$8$1$O9wlFusvYofx5iivnJGaUQ==$EKGZQsmbnnSKdsTanKpmF71nCFuKHYpDR+2DxdMKz+wluabl8lc9LgvR71RES9dMJRvET/THyWvFKtKMv1qXgA=='),
    ('ankit', 'Ankit Sharma', 'front_desk', 'Guest Service Associate', 'Front Office', 'Morning', 2, 'EMP-003', '1995-01-22', 'A+', 'scrypt$16384$8$1$YroajP24jbVkJQPHFX4NOg==$4c+WJ7H4ApW7bTKPMoo0Mx6VLXOzYCIYcs30HYFKoBYDtq3M7m2NWtx6w8wB1a2fpOKRuXbI30P/rQcBrMuelw=='),
    ('sneha', 'Sneha Kulkarni', 'front_desk', 'Guest Service Associate', 'Front Office', 'Afternoon', 3, 'EMP-004', '1997-06-15', 'B+', 'scrypt$16384$8$1$Bag0ktb0VDp4U9TnzrARdw==$jqg6N0mfUvUbzLsNXQ3NGEhTMA4DZkBacPSjpewBItrszxVo6YlfIeGlA8dd7ciIJAqOKMYAkI17eSLcZwnbxg=='),
    ('vikram', 'Vikram Rathod', 'night_auditor', 'Night Auditor', 'Front Office', 'Night', 1, 'EMP-005', '1990-11-30', 'O-', 'scrypt$16384$8$1$rkXhxZwEvoVCiF098G0cfA==$EjU9C2ssSxHCKwNEo/1tRtPJYnSE4/KwqnA/yWUf50R/TDdH4yAiL+pi/7I/ncYbgy+1wyiIBYt+/LTqXIPhEg=='),
    ('meera', 'Meera Joshi', 'reservations_agent', 'Reservations Executive', 'Sales & Marketing', 'Morning', 0, 'EMP-006', '1993-03-08', 'AB+', 'scrypt$16384$8$1$5KTRdnYYGOr1oURwwNS9WA==$t4+HOTGD7ZEB/85GGelG4N/mKfvXUqyUFKFkZlb7yRUIIDuSHBvhLQrB7pEFR8+qGCquATcmeT6KQINLjqbHww=='),
    ('sunita', 'Sunita Devi', 'housekeeping_supervisor', 'Executive Housekeeper', 'Housekeeping', 'Morning', 4, 'EMP-007', '1982-07-19', 'B-', 'scrypt$16384$8$1$jsYA4cqMvh/OzC35WB9z6Q==$e5Q39ImAvjgpQGDsBdcMX26DUmk0C8+PsubTB9XNrkXxvFeutTNDDK/SoMruJkGApXXhP5836x8e1VGA7rkZTQ=='),
    ('ramesh', 'Ramesh Yadav', 'housekeeping', 'Room Attendant', 'Housekeeping', 'Morning', 5, 'EMP-008', '1991-02-11', 'O+', 'scrypt$16384$8$1$vTNcdN+KN5VpEN4bdOZRCg==$RA8htH+BcF5rx2mDSWmaOum9fGuGQfhB4d4QD2MlIv0wqQT3npHTidGyhJfs+jpkVoLK8fOi5omN8T6zKkLYUg=='),
    ('lakshmi', 'Lakshmi Pillai', 'housekeeping', 'Room Attendant', 'Housekeeping', 'Morning', 3, 'EMP-009', '1994-12-01', 'A-', 'scrypt$16384$8$1$YHHS/P2KgD5Ycv/lyw/bGw==$3fWmY5iz+O194vCC3kUPsudSr8+QAji1EPgMe6rV64/iJCVefF/bd/bG3A7d1PVY9GKn2k+JmE6zCSgMClIKdw=='),
    ('imran', 'Imran Khan', 'housekeeping', 'Room Attendant', 'Housekeeping', 'Afternoon', 1, 'EMP-010', '1996-08-25', 'B+', 'scrypt$16384$8$1$/zowLf/AbCTCQADmGXBAsA==$PQFXfovo+/nl1aYAlXmv1GG8uAuJdawl2+4YpKIS/AJSnoKbqesOaPdGC00weYHzOtygw3Te3TA1DpcMXdMQnA=='),
    ('suresh', 'Suresh Patil', 'maintenance', 'Maintenance Technician', 'Engineering', 'Morning', 0, 'EMP-011', '1984-05-14', 'O+', 'scrypt$16384$8$1$UhSz+RosTW5GrMQngHceAQ==$e2xNX35OEqb1eA8S9hiQxo1DgQPPhXdInRWuip2jwFTZymRmImMP+Esl76oSihsV1I174ZYA3OtKFBx/nH3wNg=='),
    ('arjun', 'Arjun Malhotra', 'fb_manager', 'F&B Manager', 'Food & Beverage', 'Afternoon', 1, 'EMP-012', '1985-10-09', 'A+', 'scrypt$16384$8$1$c+UUsYXqL+QW73h3DbTBsw==$F8v/6Wy+mTf13ntISH5+EUWeOovRSvNZZtoBv+jj8Cx1UHHNFAM0RLms6/5MvExTBrAB8AcETXysj7xC4laUnw=='),
    ('kavita', 'Kavita Singh', 'pos_cashier', 'Restaurant Cashier', 'Food & Beverage', 'Afternoon', 2, 'EMP-013', '1998-04-27', 'AB-', 'scrypt$16384$8$1$1xtcs4aVheZcmGuZCm72BQ==$lQR9mDT6+K4QZGFOb7Kla4Qtmi8dCy/MSu/KV50oNRl4n15bpIStucjN0azv9xGqk0YcIsdPSBXJ6dbhaszj/g=='),
    ('nikhil', 'Nikhil Agarwal', 'finance', 'Accounts Manager', 'Finance', 'Morning', 0, 'EMP-014', '1988-01-17', 'B+', 'scrypt$16384$8$1$ODhOp6NbTfnlfaros8MgmA==$lgQMfSi+IavgLiqPQ36IvCbOZnL5dJu7YO3P1X8c44uwPb/K35AAQdCpGYKa5Qyz1FTfz9GM3xSZYaYamGywrw=='),
    ('farah', 'Farah Sheikh', 'banquet_manager', 'Banquet & Events Manager', 'Sales & Marketing', 'Morning', 5, 'EMP-015', '1989-06-30', 'O+', 'scrypt$16384$8$1$nd3p7OQi1G+nl/3C+uE9bw==$CoJfB2ettQoopQPlG6rD/GJsFt0g4VXLpLEB6TfNXnCgePHKxTOz69fyNWsqKAYXVQGSxcbefmkF4wZDEIMSzA=='),
    ('pooja', 'Pooja Menon', 'guest_relations', 'Guest Relations Executive', 'Front Office', 'Morning', 4, 'EMP-016', '1996-09-21', 'A+', 'scrypt$16384$8$1$9FNNnpRDWxhpxguzqYDNaQ==$fNERaHk/i98dMaQ2MclfgCyobsIWmutd7W6rdSB1pogONZScvQR1FQqFJyt1SYjq34TXAJalwmW5RCtWT3zS8A=='))
    x (k, name, role, title, dept, shift, off, code, dob, blood, hash)
  loop
    insert into auth.users (email, encrypted_password, raw_user_meta_data, email_confirmed_at, created_at)
    values (replace(lower(r.name), ' ', '.') || '@example.com', r.hash, jsonb_build_object('full_name', r.name),
            now() - interval '200 days', now() - interval '200 days')
    returning id into v;
    insert into staff (id, email, full_name, role, is_active, phone, job_title, must_change_password, property_id,
                       employee_code, department_id, joining_date, default_shift_id, weekly_off, address,
                       emergency_contact, date_of_birth, blood_group, created_at, on_duty)
    values (v, replace(lower(r.name), ' ', '.') || '@example.com', r.name, r.role, true,
            '+91 9' || lpad((abs(hashtext(r.name)) % 1000000000)::text, 9, '0'), r.title, false, v_prop,
            r.code, (select id from departments where property_id = v_prop and name = r.dept),
            pg_temp.today() - (400 + abs(hashtext(r.code)) % 900),
            (select id from shift_types where property_id = v_prop and name = r.shift), r.off,
            'Pune, Maharashtra', 'Family — +91 98' || lpad((abs(hashtext(r.k)) % 100000000)::text, 8, '0'),
            r.dob::date, r.blood, now() - interval '200 days', true);
    perform pg_temp.setref('staff:' || r.k, v);
  end loop;
end $$;

insert into housekeeping_zones (name, floors, sort_order) values ('Floors 1 & 2', '{1,2}', 1), ('Floors 3 & 4', '{3,4}', 2);
update staff set hk_zone_id = (select id from housekeeping_zones where property_id = pg_temp.prop() and name = 'Floors 1 & 2')
 where id in (pg_temp.ref('staff:ramesh'), pg_temp.ref('staff:imran'));
update staff set hk_zone_id = (select id from housekeeping_zones where property_id = pg_temp.prop() and name = 'Floors 3 & 4')
 where id = pg_temp.ref('staff:lakshmi');

-- ── Guests ──────────────────────────────────────────────────────────────────
-- (key, name, gender, city, country, nationality, company, vip, tier, dob shift, anniversary shift, dietary, notes)
-- "dob/anniv shift" places a birthday or anniversary that many days from today,
-- so the Occasions page always has something coming up.
create table pg_temp.gseed (k text, name text, gender text, city text, country text, nat text, co text, vip boolean,
                            tier text, dob_in int, anniv_in int, dietary text, prefs text, kind text);
insert into pg_temp.gseed values
 ('aarav','Aarav Mehta','male','Mumbai','India','Indian',null,true,'platinum',3,null,'','High floor, feather-free pillows','indian'),
 ('priyanka','Priyanka Desai','female','Pune','India','Indian',null,false,'gold',null,12,'Jain','Late check-out when possible','indian'),
 ('rohan','Rohan Kapoor','male','New Delhi','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('ananya','Ananya Iyer','female','Chennai','India','Indian',null,false,'silver',18,null,'Vegetarian','','indian'),
 ('vivek','Vivek Reddy','male','Hyderabad','India','Indian','zenith',false,'gold',null,null,'','Quiet room away from lift','corp'),
 ('kavya','Kavya Menon','female','Kochi','India','Indian',null,true,'gold',null,5,'','Extra towels','indian'),
 ('siddharth','Siddharth Jain','male','Jaipur','India','Indian',null,false,null,null,null,'Jain','','indian'),
 ('neha','Neha Gupta','female','Lucknow','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('karan','Karan Malhotra','male','Bengaluru','India','Indian','zenith',false,'silver',null,null,'','','corp'),
 ('ishita','Ishita Banerjee','female','Kolkata','India','Indian',null,false,null,25,null,'','','indian'),
 ('aditya','Aditya Rao','male','Bengaluru','India','Indian','zenith',false,null,null,null,'','','corp'),
 ('pooja_s','Pooja Shah','female','Ahmedabad','India','Indian',null,false,null,null,null,'Vegetarian','','indian'),
 ('rahul','Rahul Bhatia','male','Chandigarh','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('divya','Divya Krishnan','female','Coimbatore','India','Indian',null,false,null,null,20,'','','indian'),
 ('manish','Manish Agarwal','male','Ahmedabad','India','Indian','meridian',false,'gold',null,null,'Vegetarian','Newspaper: Economic Times','corp'),
 ('shreya','Shreya Chatterjee','female','Kolkata','India','Indian',null,false,null,null,null,'','','indian'),
 ('varun','Varun Saxena','male','Indore','India','Indian',null,false,null,null,null,'','','indian'),
 ('ritu','Ritu Sinha','female','Patna','India','Indian',null,false,null,null,null,'','','indian'),
 ('harsh','Harsh Vardhan Patel','male','Surat','India','Indian','meridian',false,null,null,null,'Vegetarian','','corp'),
 ('nandini','Nandini Pillai','female','Thiruvananthapuram','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('abhishek','Abhishek Tiwari','male','Bhopal','India','Indian',null,false,null,null,null,'','','indian'),
 ('sanya','Sanya Arora','female','Mumbai','India','Indian',null,true,null,null,null,'Vegan','Travel writer — arrange property tour','indian'),
 ('gaurav','Gaurav Chauhan','male','Dehradun','India','Indian',null,false,null,null,null,'','','indian'),
 ('meghna','Meghna Kulkarni','female','Nagpur','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('arjun_n','Arjun Nambiar','male','Kochi','India','Indian',null,false,'gold',null,1,'','Anniversary trip — surprise cake','indian'),
 ('tanvi','Tanvi Joshi','female','Pune','India','Indian',null,false,null,9,null,'','','indian'),
 ('kunal','Kunal Bose','male','Kolkata','India','Indian','coastal',false,null,null,null,'','','corp'),
 ('aishwarya','Aishwarya Hegde','female','Mangaluru','India','Indian',null,false,null,null,null,'','','indian'),
 ('nikhil_b','Nikhil Bansal','male','Gurugram','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('swati','Swati Mishra','female','Varanasi','India','Indian',null,false,null,null,null,'Vegetarian','','indian'),
 ('prakash','Prakash Shetty','male','Mumbai','India','Indian','coastal',false,'silver',null,null,'','','corp'),
 ('deepika','Deepika Rangan','female','Bengaluru','India','Indian',null,false,null,null,null,'','','indian'),
 ('yash','Yash Thakkar','male','Vadodara','India','Indian','meridian',false,null,null,null,'Jain','','corp'),
 ('sakshi','Sakshi Oberoi','female','Amritsar','India','Indian',null,false,null,2,null,'','','indian'),
 ('raghav','Raghav Sethi','male','New Delhi','India','Indian','northstar',false,'gold',null,null,'','Prefers twin beds','corp'),
 ('lavanya','Lavanya Subramanian','female','Chennai','India','Indian',null,false,null,null,null,'Vegetarian','','indian'),
 ('mohit','Mohit Khurana','male','Ludhiana','India','Indian',null,false,null,null,null,'','','indian'),
 ('anjali','Anjali Dubey','female','Raipur','India','Indian',null,false,null,null,28,'','','indian'),
 ('sameer','Sameer Kulkarni','male','Pune','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('pallavi','Pallavi Ghosh','female','Guwahati','India','Indian',null,false,null,null,null,'','','indian'),
 ('vikas','Vikas Pandey','male','Kanpur','India','Indian','northstar',false,null,null,null,'','','corp'),
 ('shalini','Shalini Venkatesh','female','Mysuru','India','Indian',null,false,null,null,null,'','','indian'),
 ('aniket','Aniket Deshmukh','male','Nashik','India','Indian',null,false,null,14,null,'','','indian'),
 ('rekha','Rekha Nair','female','Kozhikode','India','Indian',null,false,null,null,null,'','','indian'),
 ('tarun','Tarun Ahuja','male','Jaipur','India','Indian',null,false,null,null,null,'','','indian'),
 ('simran','Simran Kaur','female','Amritsar','India','Indian',null,false,'silver',null,null,'','','indian'),
 ('devendra','Devendra Singh Rathore','male','Jodhpur','India','Indian',null,false,null,null,null,'','','indian'),
 ('bhavna','Bhavna Trivedi','female','Rajkot','India','Indian',null,false,null,null,null,'Vegetarian','','indian'),
 ('amit','Amit Verma','male','Noida','India','Indian',null,false,null,null,null,'','','indian'),
 ('amit_dup','Amit Verma','male','Noida','India','Indian',null,false,null,null,null,'','','dup'),
 ('rohit_k','Rohit Khanna','male','Mumbai','India','Indian',null,false,null,null,null,'','','blacklist'),
 ('james','James Whitfield','male','London','United Kingdom','British',null,false,'silver',null,null,'','','foreign'),
 ('sophie','Sophie Laurent','female','Lyon','France','French',null,false,null,null,null,'Vegetarian','','foreign'),
 ('michael','Michael Chen','male','San Jose','United States','American',null,false,null,null,null,'','','foreign'),
 ('hannah','Hannah Müller','female','Munich','Germany','German',null,false,'gold',null,null,'','Long-stay rate agreed by GM','foreign'),
 ('kenji','Kenji Watanabe','male','Osaka','Japan','Japanese',null,false,null,null,null,'','','foreign'),
 ('olivia','Olivia Bennett','female','Melbourne','Australia','Australian',null,false,null,null,null,'Gluten-free','','foreign'),
 ('ahmed','Ahmed Al Mansoori','male','Dubai','United Arab Emirates','Emirati',null,true,'platinum',null,null,'Halal','Airport pickup in a sedan','foreign'),
 ('elena','Elena Rossi','female','Milan','Italy','Italian',null,false,null,null,null,'','','foreign');

do $$
declare r record; v uuid; i int := 0; v_phone text; v_email text; T date := pg_temp.today();
begin
  for r in select * from pg_temp.gseed loop
    i := i + 1;
    v_phone := case
      when r.k = 'amit_dup' then '+91 98765 43210'
      when r.k = 'amit' then '+919876543210'
      when r.kind = 'foreign' then case r.country when 'United Kingdom' then '+44 7700 900' || lpad(i::text, 3, '0')
                                                  when 'United States' then '+1 408 555 01' || lpad(i::text, 2, '0')
                                                  when 'United Arab Emirates' then '+971 50 555 0' || lpad(i::text, 3, '0')
                                                  else '+' || (30 + i) || ' 555 01' || lpad(i::text, 3, '0') end
      else '+91 9' || lpad(((i * 7919 + 31337) % 10000)::text, 4, '0') || ' ' || lpad(((i * 48271) % 100000)::text, 5, '0') end;
    v_email := case when r.k = 'amit_dup' then 'amitv.work@example.com'
                    else replace(replace(lower(r.name), ' ', '.'), 'ü', 'u') || case when r.kind = 'foreign' then '@example.com' else '@example.in' end end;
    insert into guests (full_name, email, phone, address, city, country, nationality, gender, company_id, tags, notes,
                        preferences, dietary, date_of_birth, anniversary, marketing_opt_in, blacklist_reason,
                        preferred_room_type_id, created_at)
    values (r.name, v_email, v_phone,
            case when r.kind = 'foreign' then (10 + i) || ' Harbour Street' else (i * 3 + 7) || ', ' || pg_temp.pick(array['MG Road','Park Street','Linking Road','Residency Road','Civil Lines','Ashram Road','Anna Salai','Lake View Colony']) end
              || ', ' || r.city,
            r.city, r.country, r.nat, r.gender,
            case when r.co is not null then pg_temp.ref('co:' || r.co) end,
            case when r.vip then '{VIP}'::text[] else '{}'::text[] end
              || case when r.kind = 'corp' then '{Corporate}'::text[] else '{}'::text[] end
              || case when r.k in ('sanya') then '{Influencer}'::text[] else '{}'::text[] end,
            case when r.k = 'amit_dup' then 'Walk-in profile created at the desk.'
                 when r.kind = 'blacklist' then 'Do not accept bookings without GM approval.' else '' end,
            r.prefs, r.dietary,
            case when r.dob_in is not null then (T + r.dob_in) - make_interval(years => 28 + i % 20)
                 else make_date(1965 + (i * 7) % 35, 1 + (i * 5) % 12, 1 + (i * 11) % 28) end,
            case when r.anniv_in is not null then (T + r.anniv_in) - make_interval(years => 3 + i % 15) end,
            i % 3 <> 0,
            case when r.kind = 'blacklist' then 'Damaged room furniture and left without settling the minibar bill.' else '' end,
            null,
            now() - make_interval(days => 60 + (i * 13) % 500))
    returning id into v;
    perform pg_temp.setref('guest:' || r.k, v);

    -- Identity on file for most guests (fake numbers).
    if r.kind = 'foreign' then
      insert into guest_identities (guest_id, id_type, id_number, issuing_country, expiry_date, visa_number, updated_by)
      values (v, 'passport', upper(left(r.nat, 1)) || lpad(((i * 104729) % 10000000)::text, 8, '0'), r.country,
              T + 900 + i * 30, 'IN-EV-' || lpad(((i * 7907) % 1000000)::text, 6, '0'), pg_temp.admin());
    elsif i % 4 <> 0 then
      insert into guest_identities (guest_id, id_type, id_number, issuing_country, updated_by)
      values (v, case when i % 5 = 0 then 'driving_licence' else 'aadhaar' end,
              case when i % 5 = 0 then 'MH12' || lpad(((i * 99991) % 100000000000)::text, 11, '0')
                   else lpad(((i * 123457 + 2345) % 10000)::text, 4, '0') || ' ' || lpad(((i * 76543) % 10000)::text, 4, '0') || ' ' || lpad(((i * 1597) % 10000)::text, 4, '0') end,
              'India', pg_temp.admin());
    end if;

    -- Loyalty membership (as loyalty_enroll, with the tier the member has earned).
    if r.tier is not null then
      update guests set loyalty_opt_in = true,
             loyalty_member_no = 'RR' || lpad(nextval('loyalty_member_seq')::text, 6, '0'),
             loyalty_tier = r.tier, loyalty_joined_on = T - (90 + (i * 37) % 600)
       where id = v;
      insert into loyalty_tier_history (guest_id, from_tier, to_tier, reason, changed_by, changed_at)
      values (v, null, 'silver', 'Enrolled', pg_temp.admin(), (T - (90 + (i * 37) % 600))::timestamptz + interval '15 hours');
      if r.tier in ('gold', 'platinum') then
        insert into loyalty_tier_history (guest_id, from_tier, to_tier, reason, nights, spend, changed_by, changed_at)
        values (v, 'silver', 'gold', 'Qualified: nights and spend over the last 12 months', 12, 92000, null,
                (T - (40 + i % 30))::timestamptz + interval '23 hours 55 minutes');
      end if;
      if r.tier = 'platinum' then
        insert into loyalty_tier_history (guest_id, from_tier, to_tier, reason, nights, spend, changed_by, changed_at)
        values (v, 'gold', 'platinum', 'Qualified: nights and spend over the last 12 months', 27, 236000, null,
                (T - (10 + i % 8))::timestamptz + interval '23 hours 55 minutes');
      end if;
      -- Points carried in from earlier stays, and a welcome bonus.
      insert into loyalty_transactions (guest_id, kind, points, remaining, base_amount, tier, description, expires_on, created_by, created_at)
      values (v, 'adjust', case r.tier when 'platinum' then 4800 when 'gold' then 2100 else 500 end,
              case r.tier when 'platinum' then 4800 when 'gold' then 2100 else 500 end, 0, r.tier,
              case r.tier when 'silver' then 'Welcome bonus' else 'Balance brought forward from earlier stays' end,
              T + 300, pg_temp.admin(), (T - 60)::timestamptz + interval '11 hours');
    end if;
  end loop;
end $$;

-- ── Outlet menus (the seven seeded outlets) ─────────────────────────────────
-- The bar, spa and gift shop ship switched off; the demo opens them (remove_demo.sql switches them back).
insert into demo_seed.info values ('outlets_before',
  (select jsonb_agg(jsonb_build_object('id', id, 'is_active', is_active)) from pos_outlets where property_id = pg_temp.prop())::text);
update pos_outlets set is_active = true where property_id = pg_temp.prop() and code in ('BAR', 'SPA', 'SHP') and not is_active;
create table pg_temp.menu (outlet text, cat text, name text, price numeric, descr text);
insert into pg_temp.menu values
 ('RST','Starters','Paneer Tikka',425,'Tandoor-grilled cottage cheese, mint chutney'),
 ('RST','Starters','Chicken Malai Tikka',495,'Cream and cardamom marinade'),
 ('RST','Starters','Veg Manchow Soup',245,''),
 ('RST','Mains','Dal Makhani',395,'Slow-cooked black lentils'),
 ('RST','Mains','Butter Chicken',545,''),
 ('RST','Mains','Paneer Butter Masala',445,''),
 ('RST','Mains','Mutton Rogan Josh',645,'Kashmiri style'),
 ('RST','Mains','Chicken Dum Biryani',525,'Served with raita'),
 ('RST','Mains','Veg Biryani',425,''),
 ('RST','Breads & Rice','Butter Naan',85,''),
 ('RST','Breads & Rice','Garlic Naan',95,''),
 ('RST','Breads & Rice','Jeera Rice',245,''),
 ('RST','Desserts','Gulab Jamun',195,''),
 ('RST','Desserts','Rasmalai',225,''),
 ('RST','Beverages','Masala Chai',120,''),
 ('RST','Beverages','Fresh Lime Soda',150,''),
 ('RST','Beverages','Cold Coffee',220,''),
 ('BAR','Beer','Kingfisher Premium 650 ml',425,''),
 ('BAR','Beer','Draught Beer 500 ml',375,''),
 ('BAR','Spirits','Old Monk Rum 60 ml',345,''),
 ('BAR','Spirits','Johnnie Walker Black Label 60 ml',795,''),
 ('BAR','Wine','Sula Sauvignon Blanc (glass)',595,''),
 ('BAR','Cocktails','Classic Mojito',495,''),
 ('BAR','Cocktails','Virgin Mojito',295,''),
 ('BAR','Bar bites','Masala Peanuts',195,''),
 ('BAR','Bar bites','Chicken 65',445,''),
 ('RMS','All day','Club Sandwich',395,'With fries'),
 ('RMS','All day','Masala Omelette',245,''),
 ('RMS','All day','Veg Hakka Noodles',375,''),
 ('RMS','All day','Butter Chicken with Naan',645,''),
 ('RMS','All day','Fresh Fruit Platter',325,''),
 ('RMS','All day','Hot Chocolate',225,''),
 ('MIN','Mini-bar','Coca-Cola 300 ml',120,''),
 ('MIN','Mini-bar','Mineral Water 1 L',80,''),
 ('MIN','Mini-bar','Lay''s Classic Salted',90,''),
 ('MIN','Mini-bar','Cadbury Dairy Milk Silk',150,''),
 ('MIN','Mini-bar','Red Bull 250 ml',250,''),
 ('MIN','Mini-bar','Haldiram''s Bhujia',110,''),
 ('MIN','Mini-bar','Kingfisher Beer 500 ml can',275,''),
 ('LDY','Laundry','Shirt — wash & iron',120,''),
 ('LDY','Laundry','Trousers — wash & iron',140,''),
 ('LDY','Dry cleaning','Saree — dry clean',450,''),
 ('LDY','Dry cleaning','Suit — dry clean',650,''),
 ('SPA','Massages','Swedish Massage 60 min',3500,''),
 ('SPA','Massages','Balinese Massage 90 min',4800,''),
 ('SPA','Massages','Ayurvedic Abhyanga 60 min',3800,''),
 ('SPA','Therapies','Foot Reflexology 30 min',1500,''),
 ('SHP','Gifts','Brass Diya (handcrafted)',850,''),
 ('SHP','Gifts','Darjeeling Tea Gift Box',1200,''),
 ('SHP','Gifts','Pashmina Stole',3500,'');

insert into pos_categories (outlet_id, name, sort_order)
select o.id, m.cat, min(ord)
  from (select *, row_number() over () as ord from pg_temp.menu) m
  join pos_outlets o on o.code = m.outlet and o.property_id = pg_temp.prop()
 group by o.id, m.cat
on conflict do nothing;
insert into pos_items (outlet_id, category_id, code, name, description, price, sort_order)
select o.id, c.id, m.outlet || lpad(m.ord::text, 3, '0'), m.name, m.descr, m.price, m.ord
  from (select *, row_number() over () as ord from pg_temp.menu) m
  join pos_outlets o on o.code = m.outlet and o.property_id = pg_temp.prop()
  join pos_categories c on c.outlet_id = o.id and c.name = m.cat;
insert into pos_modifiers (outlet_id, name, price_delta, sort_order)
select o.id, x.n, x.p, x.s from pos_outlets o,
  (values ('Extra butter', 40, 1), ('Less spicy', 0, 2), ('Jain preparation', 0, 3)) x (n, p, s)
 where o.code = 'RST' and o.property_id = pg_temp.prop();
insert into pos_item_modifiers (item_id, modifier_id)
select i.id, m.id from pos_items i join pos_modifiers m on m.outlet_id = i.outlet_id
 where i.name in ('Dal Makhani', 'Paneer Butter Masala', 'Butter Chicken', 'Veg Biryani');

-- ── Inventory ───────────────────────────────────────────────────────────────
insert into inventory_locations (name, kind, outlet_id, hk_default, sort_order) values
 ('Main Store', 'store', null, false, 1),
 ('Housekeeping Pantry', 'floor', null, true, 2),
 ('Bar Store', 'outlet', (select id from pos_outlets where code = 'BAR' and property_id = pg_temp.prop()), false, 3),
 ('Mini-bar Stock', 'outlet', (select id from pos_outlets where code = 'MIN' and property_id = pg_temp.prop()), false, 4),
 ('Kitchen Store', 'store', null, false, 5);
insert into demo_seed.ref select 'loc:' || lower(split_part(name, ' ', 1)), id from inventory_locations
 where property_id = pg_temp.prop() and id::text not in (select id from demo_seed.pre where tbl = 'inventory_locations');

create table pg_temp.inv (sku text, name text, cat text, unit text, par numeric, reorder numeric, cost numeric, pos text, hk text, home text, opening numeric);
insert into pg_temp.inv values
 ('MB-COKE','Coca-Cola 300 ml','minibar','bottle',120,40,28,'Coca-Cola 300 ml',null,'mini-bar',150),
 ('MB-WATER','Mineral Water 1 L','minibar','bottle',200,60,14,'Mineral Water 1 L',null,'mini-bar',240),
 ('MB-LAYS','Lay''s Classic Salted 52 g','minibar','pack',100,30,18,'Lay''s Classic Salted',null,'mini-bar',120),
 ('MB-SILK','Cadbury Dairy Milk Silk 60 g','minibar','bar',80,25,62,'Cadbury Dairy Milk Silk',null,'mini-bar',90),
 ('MB-REDBULL','Red Bull 250 ml','minibar','can',60,20,95,'Red Bull 250 ml',null,'mini-bar',45),
 ('MB-BHUJIA','Haldiram''s Bhujia 150 g','minibar','pack',60,20,38,'Haldiram''s Bhujia',null,'mini-bar',70),
 ('MB-KFCAN','Kingfisher Beer 500 ml can','beverage','can',96,24,110,'Kingfisher Beer 500 ml can',null,'mini-bar',100),
 ('BAR-KF650','Kingfisher Premium 650 ml','beverage','bottle',120,36,135,'Kingfisher Premium 650 ml',null,'bar',140),
 ('AM-SHAMPOO','Shampoo & conditioner 30 ml','amenity','bottle',600,200,9,null,'Shampoo & conditioner','housekeeping',700),
 ('AM-SOAP','Soap & body wash 30 g','amenity','each',600,200,7,null,'Soap & body wash','housekeeping',700),
 ('AM-DENTAL','Dental kit','amenity','kit',400,120,11,null,'Dental kit','housekeeping',500),
 ('AM-TEA','Tea & coffee sachet set','amenity','set',500,150,15,null,'Tea & coffee sachets','housekeeping',600),
 ('AM-WATER','Drinking water 500 ml','amenity','bottle',800,250,8,null,'Drinking water','housekeeping',900),
 ('LN-TOWEL','Bath towel','linen','each',180,60,420,null,null,'main',200),
 ('LN-SHEET','Bed sheet (king)','linen','each',150,50,780,null,null,'main',160),
 ('CL-FLOOR','Floor cleaner 5 L','cleaning','can',20,6,640,null,null,'main',24),
 ('CL-GLASS','Glass cleaner 500 ml','cleaning','bottle',30,10,145,null,null,'main',8),
 ('EN-LED9','LED bulb 9 W','engineering','each',50,15,95,null,null,'main',60),
 ('EN-ACFLT','AC filter (split unit)','engineering','each',30,10,350,null,null,'main',32),
 ('FD-RICE','Basmati rice 25 kg','food','bag',8,3,2450,null,null,'kitchen',10),
 ('FD-PANEER','Paneer','food','kg',40,15,340,null,null,'kitchen',45),
 ('BV-COFFEE','Coffee beans 1 kg','beverage','kg',12,4,1150,null,null,'kitchen',14);

insert into inventory_items (sku, name, category, unit, par_level, reorder_level, unit_cost)
select sku, name, cat, unit, par, reorder, cost from pg_temp.inv;
insert into demo_seed.ref select 'inv:' || sku, id from inventory_items
 where property_id = pg_temp.prop() and id::text not in (select id from demo_seed.pre where tbl = 'inventory_items');

-- POS items map to stock for the consumption the outlets record; the links on
-- inventory_items themselves are set at the end, so that history written here
-- is not counted twice by the live triggers.
create table pg_temp.inv_pos (pos_item uuid, inv_item uuid);
insert into pg_temp.inv_pos
select pi.id, pg_temp.ref('inv:' || i.sku)
  from pg_temp.inv i join pos_items pi on pi.name = i.pos and pi.property_id = pg_temp.prop()
 where i.pos is not null;

-- Opening stock 29 days ago, a top-up a fortnight later, transfers to outlets.
do $$
declare r record; T date := pg_temp.today(); v_main uuid := pg_temp.ref('loc:main'); v_home uuid; v_tr uuid; v_by uuid := pg_temp.ref('staff:sunita');
begin
  for r in select i.*, pg_temp.ref('inv:' || i.sku) as id from pg_temp.inv i loop
    insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by, created_at)
    values (r.id, v_main, 'receive', r.opening * 2, r.cost, 'Opening purchase', 'PO-' || to_char(T - 29, 'YYMMDD') || '-01', pg_temp.ref('staff:nikhil'),
            (T - 29) + time '11:20');
    insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by, created_at)
    values (r.id, v_main, 'receive', round(r.opening * 0.5), r.cost, 'Fortnightly top-up', 'PO-' || to_char(T - 14, 'YYMMDD') || '-02', pg_temp.ref('staff:nikhil'),
            (T - 14) + time '12:05');
    if r.home <> 'main' then
      v_home := pg_temp.ref('loc:' || r.home);
      v_tr := gen_random_uuid();
      insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, transfer_id, created_by, created_at)
      values (r.id, v_main, 'transfer', -r.opening, r.cost, 'Issue to ' || r.home, 'TR-' || to_char(T - 28, 'YYMMDD'), v_tr, v_by, (T - 28) + time '09:30'),
             (r.id, v_home, 'transfer', r.opening, r.cost, 'Issue to ' || r.home, 'TR-' || to_char(T - 28, 'YYMMDD'), v_tr, v_by, (T - 28) + time '09:30');
      v_tr := gen_random_uuid();
      insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, transfer_id, created_by, created_at)
      values (r.id, v_main, 'transfer', -round(r.opening * 0.5), r.cost, 'Top-up to ' || r.home, 'TR-' || to_char(T - 13, 'YYMMDD'), v_tr, v_by, (T - 13) + time '09:30'),
             (r.id, v_home, 'transfer', round(r.opening * 0.5), r.cost, 'Top-up to ' || r.home, 'TR-' || to_char(T - 13, 'YYMMDD'), v_tr, v_by, (T - 13) + time '09:30');
    end if;
  end loop;
  -- Write-offs and a stock count.
  insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by, created_at) values
   (pg_temp.ref('inv:FD-PANEER'), pg_temp.ref('loc:kitchen'), 'wastage', -3, 340, 'Past use-by date after fridge fault', 'WO-' || to_char(T - 9, 'YYMMDD'), pg_temp.ref('staff:arjun'), (T - 9) + time '22:10'),
   (pg_temp.ref('inv:BAR-KF650'), pg_temp.ref('loc:bar'), 'wastage', -2, 135, 'Bottles broken in delivery', 'WO-' || to_char(T - 6, 'YYMMDD'), pg_temp.ref('staff:arjun'), (T - 6) + time '17:40'),
   (pg_temp.ref('inv:LN-TOWEL'), v_main, 'adjust', -6, 420, 'Monthly linen count', 'SC-' || to_char(T - 2, 'YYMMDD'), v_by, (T - 2) + time '16:00');
end $$;

-- ── Events: prices on the seeded masters (only where still zero), more spaces
insert into demo_seed.info values
 ('event_prices_before', jsonb_build_object(
    'spaces', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'rental_full_day', rental_full_day, 'rental_half_day', rental_half_day,
                                 'rental_per_hour', rental_per_hour, 'min_charge', min_charge, 'floor', floor, 'area_sqft', area_sqft)), '[]')
                 from event_spaces where property_id = pg_temp.prop()),
    'packages', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'price_per_head', price_per_head, 'min_pax', min_pax)), '[]')
                   from event_packages where property_id = pg_temp.prop()),
    'equipment', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'rental_price', rental_price)), '[]')
                    from event_equipment where property_id = pg_temp.prop()))::text);

update event_spaces set rental_full_day = 85000, rental_half_day = 50000, rental_per_hour = 12000, min_charge = 25000,
       floor = coalesce(floor, 1), area_sqft = coalesce(area_sqft, 3200)
 where property_id = pg_temp.prop() and rental_full_day = 0 and rental_half_day = 0 and rental_per_hour = 0;
update event_packages p set price_per_head = x.price, min_pax = greatest(p.min_pax, x.minpax)
  from (values ('CONF-FD', 1850, 25), ('CONF-HD', 1250, 20), ('HI-TEA', 650, 30), ('LUNCH-V', 1100, 20),
               ('DINNER', 1650, 50), ('GALA', 2600, 100)) x (code, price, minpax)
 where p.code = x.code and p.property_id = pg_temp.prop() and p.price_per_head = 0;
update event_equipment e set rental_price = x.price
  from (values ('Projector and screen', 4500), ('Public address system', 6000), ('Additional microphone', 800),
               ('Podium', 1000), ('Stage riser', 1500), ('Flipchart and whiteboard', 500), ('Laptop', 2000),
               ('Stage backdrop', 12000)) x (name, price)
 where e.name = x.name and e.property_id = pg_temp.prop() and e.rental_price = 0;

insert into event_spaces (code, name, description, floor, area_sqft, rental_full_day, rental_half_day, rental_per_hour, min_charge, tax_rate, sort_order)
values ('LOTUS', 'Lotus Boardroom', 'Board table for 16, video-conferencing screen', 2, 520, 18000, 11000, 3000, 6000, 18, 2),
       ('LAWN', 'Garden Lawn', 'Open-air lawn for weddings and receptions, up to 400 guests', 0, 9000, 150000, 90000, 0, 60000, 18, 3);
insert into demo_seed.ref select 'space:' || lower(code), id from event_spaces where property_id = pg_temp.prop()
  and code in ('LOTUS', 'LAWN') and id::text not in (select id from demo_seed.pre where tbl = 'event_spaces');
do $$ begin perform pg_temp.setref('space:hall', (select id from event_spaces where property_id = pg_temp.prop()
        and id::text in (select id from demo_seed.pre where tbl = 'event_spaces') order by sort_order limit 1)); end $$;
insert into event_layouts (space_id, name, capacity, sort_order) values
 (pg_temp.ref('space:lotus'), 'Boardroom', 16, 1), (pg_temp.ref('space:lotus'), 'U-shape', 12, 2),
 (pg_temp.ref('space:lawn'), 'Banquet (round tables)', 320, 1), (pg_temp.ref('space:lawn'), 'Cocktail (standing)', 400, 2);

-- ════════════════════════════════════════════════════════════════════════════
-- Stays: 30 days back, 30 days ahead
-- ════════════════════════════════════════════════════════════════════════════
create table pg_temp.bk (
  n serial, key text, room text, rt text, plan text, guest text, company text,
  ci date, co date, status text, source text, adults int default 2, children int default 0,
  stay_type text default 'paid', comp_reason text default '', vip boolean default false,
  deposit numeric default 0, dep_method text, pay_ci numeric default 0, ci_method text,
  settle text default 'card', corp_split boolean default false, city_ledger boolean default false,
  fx text, grp text, promo text, special text default '', pickup text, drop_at text, eta time,
  scenario text default '', lead int default 7, ci_time time default '14:20', co_time time default '10:45',
  cancel_days int, id uuid, skipped text);

-- Hand-placed stays that the demo script walks through.
do $$
declare T date := pg_temp.today();
begin
  insert into pg_temp.bk (key, room, rt, plan, guest, company, ci, co, status, source, adults, deposit, dep_method, settle,
                          corp_split, city_ledger, fx, grp, special, pickup, drop_at, eta, scenario, lead, stay_type, comp_reason,
                          vip, pay_ci, ci_method, ci_time, co_time, promo, cancel_days)
  values
   -- Corporate group in house (rooming list, company pays room and tax)
   ('grp1-1','201','rt:a','plan:corp','vivek','zenith',T-1,T+2,'checked_in','corporate',1,0,null,'card',true,false,null,'zenith','', null,null,null,'group',12,'paid','',false,0,null,'13:10','10:45',null,null),
   ('grp1-2','202','rt:a','plan:corp','karan','zenith',T-1,T+2,'checked_in','corporate',1,0,null,'card',true,false,null,'zenith','', null,null,null,'group',12,'paid','',false,0,null,'13:15','10:45',null,null),
   ('grp1-3','203','rt:a','plan:corp','aditya','zenith',T-1,T+2,'checked_in','corporate',1,0,null,'card',true,false,null,'zenith','', null,null,null,'group',12,'paid','',false,0,null,'13:25','10:45',null,null),
   -- Complimentary stay (travel writer)
   ('comp','401','rt:suite','plan:bar','sanya',null,T-2,T+1,'checked_in','email',1,0,null,'card',false,false,null,null,'Property tour and photo shoot on day two',null,null,null,'comp',10,'complimentary','Travel writer — feature in Condé-style travel magazine, approved by GM',true,0,null,'12:30','10:45',null,null),
   -- Arrivals today (two still expected, two already in)
   ('arr-vip','402','rt:suite','plan:bar','aarav',null,T,T+3,'confirmed','phone',2,12000,'card','card',false,false,null,null,'Anniversary — champagne and cake in room','Airport pickup — IndiGo 6E 2134, arrives 15:30',null,'16:00','arrival',21,'paid','',true,0,null,'14:20','10:45',null,null),
   ('arr-uk','105','rt:classic','plan:bar','james',null,T,T+4,'confirmed','ota',1,0,null,'ota_prepaid',false,false,null,null,'Late arrival after 22:00',null,null,'22:30','arrival',9,'paid','',false,0,null,'14:20','10:45',null,null),
   ('arr-in','302','rt:b','plan:map','kavya',null,T,T+2,'checked_in','website',2,6000,'upi','card',false,false,null,null,'Extra towels',null,null,'12:00','arrival',15,'paid','',true,0,null,'12:40','10:45',null,null),
   ('arr-walk','206','rt:a','plan:bar','michael',null,T,T+1,'checked_in','walk_in',1,0,null,'card',false,false,null,null,'',null,null,null,'walkin',0,'paid','',false,9500,'card','11:50','10:45',null,null),
   -- Departures today (two have left, two still to check out)
   ('dep-left1','103','rt:classic','plan:bar','neha',null,T-3,T,'checked_in','website',2,0,null,'upi',false,false,null,null,'',null,null,null,'left_today',18,'paid','',false,0,null,'14:05','08:40',null,null),
   ('dep-left2','303','rt:b','plan:bar','sophie',null,T-4,T,'checked_in','travel_agent',2,0,null,'card',false,false,'EUR',null,'',null,null,null,'left_today',30,'paid','',false,0,null,'15:30','09:10',null,null),
   ('dep-due1','208','rt:a','plan:bar','rahul',null,T-2,T,'checked_in','phone',2,5000,'upi','card',false,false,null,null,'',null,'Drop to Pune airport at 13:00',null,'due_out',8,'paid','',false,0,null,'14:45','10:45',null,null),
   ('dep-due2','304','rt:b','plan:corp','manish','meridian',T-3,T,'checked_in','corporate',1,0,null,'card',true,false,null,null,'',null,null,null,'due_out',6,'paid','',false,0,null,'16:10','10:45',null,null),
   -- In-house long stay, romance package
   ('long','403','rt:suite','plan:bar','hannah',null,T-6,T+3,'checked_in','email',1,40000,'bank_transfer','card',false,false,null,null,'Long stay — daily housekeeping after 11 am',null,null,null,'long',40,'paid','',false,0,null,'13:00','10:45',null,null),
   ('romance','404','rt:suite','plan:romance','arjun_n',null,T-1,T+1,'checked_in','website',2,9000,'card','card',false,false,null,null,'Anniversary — rose petals, cake at 9 pm',null,null,null,'romance',25,'paid','',false,0,null,'14:00','10:45',null,null),
   -- Past B2B stays
   ('b2b-cl','207','rt:a','plan:corp','karan','zenith',T-9,T-6,'checked_out','corporate',1,0,null,'card',true,true,null,null,'',null,null,null,'b2b',10,'paid','',false,0,null,'15:00','10:30',null,null),
   ('b2b-pay','305','rt:b','plan:corp','yash','meridian',T-15,T-12,'checked_out','corporate',1,0,null,'bank_transfer',false,false,null,null,'',null,null,null,'b2b',7,'paid','',false,0,null,'14:40','10:20',null,null),
   ('b2b-ns','306','rt:b','plan:corp','raghav','northstar',T-22,T-19,'checked_out','corporate',1,0,null,'bank_transfer',false,false,null,null,'',null,null,null,'b2b',9,'paid','',false,0,null,'14:00','10:50',null,null),
   -- The stay that gets a credit note and a refund today
   ('cn','307','rt:b','plan:bar','priyanka',null,T-5,T-3,'checked_out','website',2,0,null,'card',false,false,null,null,'',null,null,null,'credit_note',14,'paid','',false,0,null,'14:15','11:05',null,null),
   -- Cancellations and a no-show
   ('cxl-dep',null,'rt:b','plan:bar','rohan',null,T+6,T+9,'cancelled','website',2,6000,'upi','card',false,false,null,null,'',null,null,null,'cancel_refund',20,'paid','',false,0,null,'14:20','10:45',null,2),
   ('cxl-free',null,'rt:classic','plan:bar','ishita',null,T-8,T-6,'cancelled','phone',2,0,null,'card',false,false,null,null,'',null,null,null,'cancel',25,'paid','',false,0,null,'14:20','10:45',null,14),
   ('noshow',null,'rt:a','plan:bar','varun',null,T-6,T-4,'no_show','ota',2,0,null,'card',false,false,null,null,'',null,null,null,'no_show',5,'paid','',false,0,null,'14:20','10:45',null,null),
   -- Future: tentative hold and confirmed with deposits
   ('tent',null,'rt:classic','plan:bar','ritu',null,T+4,T+6,'tentative','phone',2,0,null,'card',false,false,null,null,'Awaiting company approval',null,null,null,'tentative',1,'paid','',false,0,null,'14:20','10:45',null,null),
   ('fut-ahmed','401','rt:suite','plan:bar','ahmed',null,T+5,T+9,'confirmed','email',2,30000,'bank_transfer','card',false,false,null,null,'Halal meals; sedan pickup','Airport pickup — EK 568, arrives 03:10',null,'04:30','future',30,'paid','',true,0,null,'14:20','10:45',null,null),
   ('fut-stay3','301','rt:b','plan:stay3','tanvi',null,T+2,T+5,'confirmed','website',2,0,null,'card',false,false,null,null,'',null,null,null,'future',11,'paid','',false,0,null,'14:20','10:45','FESTIVE15',null);

  -- Wedding group: six rooms held on the type, no rooms assigned yet.
  insert into pg_temp.bk (key, room, rt, plan, guest, ci, co, status, source, adults, grp, scenario, lead, deposit, dep_method, special)
  select 'grp2-' || g, null, 'rt:a', 'plan:grp', pg_temp.pick(array['divya','lavanya','swati','bhavna','pallavi','rekha','shalini','anjali']),
         T + 12, T + 14, 'confirmed', 'phone', 2, 'wedding', 'group', 26, case when g = 1 then 40000 else 0 end,
         case when g = 1 then 'bank_transfer' end, 'Kapoor–Bansal wedding — rooming list to follow'
    from generate_series(1, 6) g;
end $$;

-- Everything else: walk each room's calendar and fill it with ordinary stays.
do $$
declare
  T date := pg_temp.today(); r record; d date; len int; gap int; v_block date; g record; v_src text; v_plan text;
  v_status text; v_co text; v_settle text; v_lead int; x float;
begin
  for r in select room_number, case floor when 1 then 'rt:classic' when 2 then 'rt:a' when 3 then 'rt:b' else 'rt:suite' end as rt
             from rooms where property_id = pg_temp.prop() and id in (select id from demo_seed.ref where key like 'room:%')
            order by room_number loop
    d := T - 30 + pg_temp.rnd(0, 2);
    while d <= T + 30 loop
      x := random();
      len := case when x < 0.30 then 1 when x < 0.65 then 2 when x < 0.85 then 3 when x < 0.95 then 4 else pg_temp.rnd(5, 7) end;
      if r.room_number = '308' and d + len > T - 2 then exit; end if;
      select max(b.co) into v_block from pg_temp.bk b where b.room = r.room_number and b.ci < d + len and b.co > d;
      if v_block is not null then d := v_block + pg_temp.rnd(0, 1); continue; end if;
      -- Thinner the further ahead (pickup still to come).
      if d > T + 10 and random() < 0.45 then d := d + pg_temp.rnd(1, 3); continue; end if;

      select gs.* into g from pg_temp.gseed gs
       where gs.kind in ('indian', 'foreign', 'corp')
         and not exists (select 1 from pg_temp.bk b where b.guest = gs.k and b.ci < d + len and b.co > d)
         and (gs.kind <> 'corp' or extract(dow from d) between 0 and 4)
       order by random() limit 1;
      if g.k is null then d := d + 1; continue; end if;

      x := random();
      if g.kind = 'corp' then v_src := 'corporate'; v_plan := 'plan:corp';
      elsif x < 0.30 then v_src := 'ota'; v_plan := case when random() < 0.3 then 'plan:nrf' else 'plan:bar' end;
      elsif x < 0.58 then v_src := 'website'; v_plan := case when len >= 3 and random() < 0.5 then 'plan:stay3' when random() < 0.15 then 'plan:map' else 'plan:bar' end;
      elsif x < 0.73 then v_src := 'phone'; v_plan := 'plan:bar';
      elsif x < 0.83 and d <= T then v_src := 'walk_in'; v_plan := 'plan:bar';
      elsif x < 0.93 then v_src := 'travel_agent'; v_plan := case when random() < 0.4 then 'plan:map' else 'plan:bar' end;
      else v_src := 'email'; v_plan := 'plan:bar'; end if;
      if v_plan = 'plan:stay3' and len < 3 then v_plan := 'plan:bar'; end if;
      if r.rt = 'rt:suite' and v_plan = 'plan:map' then v_plan := 'plan:bar'; end if;

      v_status := case
        when d + len < T then 'checked_out'
        when d + len = T then case when random() < 0.5 then 'checked_out' else 'checked_in' end
        when d < T then 'checked_in'
        when d = T then case when random() < 0.4 then 'checked_in' else 'confirmed' end
        when d <= T + 14 and random() < 0.15 then 'tentative'
        else 'confirmed' end;
      if d < T and random() < 0.05 then v_status := 'cancelled'; end if;
      if d > T and random() < 0.04 then v_status := 'cancelled'; end if;

      v_lead := case v_src when 'walk_in' then 0 when 'ota' then pg_temp.rnd(1, 25) when 'corporate' then pg_temp.rnd(2, 15)
                           else pg_temp.rnd(3, 45) end;
      v_settle := case when v_src = 'ota' and v_plan = 'plan:bar' then 'ota_prepaid'
                       when g.kind = 'corp' then 'bank_transfer'
                       else pg_temp.pick(array['card','card','upi','upi','cash','cash']) end;

      insert into pg_temp.bk (key, room, rt, plan, guest, company, ci, co, status, source, adults, children, settle,
                              corp_split, city_ledger, scenario, lead, deposit, dep_method, pay_ci, ci_method,
                              ci_time, co_time, promo, fx, cancel_days)
      values ('auto', case when v_status = 'cancelled' or (d > T + 3 and random() < 0.35) then null else r.room_number end,
              r.rt, v_plan, g.k, g.co, d, d + len, v_status, v_src,
              case when r.rt = 'rt:suite' then pg_temp.rnd(2, 3) when random() < 0.25 then 1 else 2 end,
              case when random() < 0.12 then 1 else 0 end, v_settle,
              g.kind = 'corp' and random() < 0.5, g.co = 'zenith' and random() < 0.5,
              case when v_status = 'checked_out' and d + len = T then 'left_today' else '' end,
              v_lead,
              case when v_plan = 'plan:nrf' then -1 when g.kind <> 'corp' and v_lead >= 4 and random() < 0.3 then -0.3 else 0 end,
              pg_temp.pick(array['upi','card','bank_transfer']),
              case when v_src = 'walk_in' then -1 when v_src <> 'ota' and g.kind <> 'corp' and random() < 0.2 then -0.5 else 0 end,
              pg_temp.pick(array['card','upi','cash']),
              make_time(pg_temp.rnd(12, 19), pg_temp.rnd(0, 59), 0), make_time(pg_temp.rnd(8, 11), pg_temp.rnd(0, 59), 0),
              case when v_src = 'website' and random() < 0.15 then pg_temp.pick(array['FESTIVE15','WELCOME500']) end,
              case when g.kind = 'foreign' and random() < 0.3 then pg_temp.pick(array['USD','GBP','EUR']) end,
              case when v_status = 'cancelled' then greatest(1, v_lead / 2) end);

      gap := case when d < T then (case when random() < 0.40 then 0 when random() < 0.6 then 1 when random() < 0.7 then 2 else 3 end)
                  when d < T + 10 then pg_temp.rnd(0, 3) else pg_temp.rnd(1, 6) end;
      d := d + len + gap;
    end loop;
  end loop;
  -- A stay never begins on the hotel's first visible day without being created first.
  update pg_temp.bk set lead = 0 where source = 'walk_in';
end $$;

-- Promo codes, before the stays that use them.
insert into promo_codes (code, name, description, discount_kind, discount_value, max_discount, valid_from, valid_to,
                         stay_from, stay_to, min_nights, min_amount, max_redemptions, max_per_guest, is_public, created_by)
values
 ('FESTIVE15', 'Festive season 15% off', 'Direct bookings over the festive weeks', 'percent', 15, 3000,
  pg_temp.today() - 45, pg_temp.today() + 20, pg_temp.today() - 40, pg_temp.today() + 45, 1, 0, 200, 2, true, pg_temp.admin()),
 ('WELCOME500', 'Welcome ₹500 off', 'First direct booking', 'amount', 500, 0,
  pg_temp.today() - 90, pg_temp.today() + 90, null, null, 1, 5000, null, 1, true, pg_temp.admin()),
 ('ZENITH10', 'Zenith Infotech staff leisure', 'Not public — for Zenith employees on leisure stays', 'percent', 10, 0,
  pg_temp.today() - 30, pg_temp.today() + 180, null, null, 1, 0, 50, null, false, pg_temp.admin());

-- ── Groups and bookings ─────────────────────────────────────────────────────
insert into booking_groups (name, company_id, rate_plan_id, organiser_name, organiser_phone, organiser_email,
                            check_in, check_out, notes, created_by, created_at)
values ('Zenith Infotech — Leadership Offsite', pg_temp.ref('co:zenith'), pg_temp.ref('plan:corp'), 'Lakshmi Narayan',
        '+91 80 4123 5500', 'travel.desk@zenith.example.com', pg_temp.today() - 1, pg_temp.today() + 2,
        'Three rooms, room and tax to company. Breakout in the Lotus Boardroom.', pg_temp.ref('staff:meera'), now() - interval '12 days'),
       ('Kapoor–Bansal Wedding', null, pg_temp.ref('plan:grp'), 'Sunil Kapoor', '+91 98200 11223', 'sunil.kapoor@example.in',
        pg_temp.today() + 12, pg_temp.today() + 14, 'Six rooms on hold for the families; rooming list due a week before.',
        pg_temp.ref('staff:meera'), now() - interval '26 days');
insert into demo_seed.ref select case when name like 'Zenith%' then 'grp:zenith' else 'grp:wedding' end, id
  from booking_groups where property_id = pg_temp.prop() and id::text not in (select id from demo_seed.pre where tbl = 'booking_groups');

do $$
declare
  T date := pg_temp.today(); r record; g record; v_id uuid; v_br jsonb; v_total numeric; v_nights int; v_status text;
  v_created timestamptz; v_promo promo_codes; v_disc numeric; v_cut numeric; v_dep numeric; v_plan rate_plans;
  v_in timestamptz; v_out timestamptz; v_pen numeric; v_room uuid; v_ok int := 0; v_skip int := 0;
begin
  for r in select * from pg_temp.bk order by ci - lead, n loop
    v_promo := null;
    select * into g from pg_temp.gseed where k = r.guest;
    select * into v_plan from rate_plans where id = pg_temp.ref(r.plan);
    v_nights := r.co - r.ci;
    v_br := pg_temp.quote(pg_temp.ref(r.rt), v_plan.id, r.ci, r.co, r.adults, 1);
    v_total := (select sum((n->>'rate')::numeric) from jsonb_array_elements(v_br) n);
    v_disc := 0;
    if r.promo is not null then
      select * into v_promo from promo_codes where code = r.promo and property_id = pg_temp.prop();
      v_disc := case when v_promo.discount_kind = 'percent'
                     then least(round(v_total * v_promo.discount_value / 100), nullif(v_promo.max_discount, 0))
                     else v_promo.discount_value end;
      v_disc := coalesce(v_disc, round(v_total * v_promo.discount_value / 100));
      v_cut := round(v_disc / v_nights);
      select jsonb_agg(jsonb_build_object('date', n->>'date', 'rate', greatest(0, (n->>'rate')::numeric - v_cut)) order by n->>'date')
        into v_br from jsonb_array_elements(v_br) n;
      v_disc := v_total - (select sum((n->>'rate')::numeric) from jsonb_array_elements(v_br) n);
      v_total := v_total - v_disc;
    end if;
    -- Booked before today: a stay further ahead was made a few days ago, not in the future.
    v_created := least(least(r.ci - r.lead, T - 1 - (r.n % 12)) + make_time(pg_temp.rnd(9, 20), pg_temp.rnd(0, 59), 0),
                       now() - interval '2 hours');
    if r.source = 'walk_in' then v_created := least(r.ci + r.ci_time - interval '10 minutes', now() - interval '30 minutes'); end if;
    v_status := case when r.scenario = 'left_today' then 'checked_in' else r.status end;
    v_in := case when v_status in ('checked_in', 'checked_out') then pg_temp.ts(r.ci, r.ci_time) end;
    v_out := case when v_status = 'checked_out' then pg_temp.ts(r.co, r.co_time) end;
    v_pen := case when r.status = 'no_show' then (v_br->0->>'rate')::numeric end;
    v_room := case when r.room is not null then pg_temp.ref('room:' || r.room) end;

    begin
      insert into bookings (guest_id, room_type_id, room_id, rate_plan_id, company_id, group_id, check_in, check_out,
                            adults, children, rooms_count, status, source, payment_method, promo_code, promo_code_id, promo_discount,
                            quoted_rate, total_amount, rate_breakdown, deposit_required, hold_until, is_vip, eta,
                            special_requests, contact_name, contact_email, contact_phone, created_by, created_at, updated_at,
                            checked_in_at, checked_in_by, checked_out_at, checked_out_by,
                            cancelled_at, cancelled_by, cancellation_reason, penalty_amount,
                            pickup_required, pickup_at, pickup_details, drop_required, drop_at, drop_details,
                            stay_type, comp_reason, confirmation_sent_at)
      values (pg_temp.ref('guest:' || r.guest), pg_temp.ref(r.rt), v_room, v_plan.id,
              case when r.company is not null then pg_temp.ref('co:' || r.company) end,
              case when r.grp is not null then pg_temp.ref('grp:' || r.grp) end,
              r.ci, r.co, r.adults, r.children, 1, v_status::booking_status, r.source::booking_source,
              case when r.settle = 'ota_prepaid' then 'ota_prepaid' when r.company is not null then 'corporate_billing' else r.settle end::payment_method,
              coalesce(r.promo, ''), v_promo.id, v_disc,
              round(v_total / v_nights), v_total, v_br, round(v_total * v_plan.deposit_percent / 100),
              case when v_status = 'tentative' then now() + interval '20 hours' end,
              r.vip or g.vip, r.eta, r.special, g.name,
              (select email from guests where id = pg_temp.ref('guest:' || r.guest)),
              (select phone from guests where id = pg_temp.ref('guest:' || r.guest)),
              case when r.source in ('walk_in', 'phone', 'email') then pg_temp.desk(v_created) else pg_temp.ref('staff:meera') end,
              v_created, v_created,
              v_in, case when v_in is not null then pg_temp.desk(v_in) end,
              v_out, case when v_out is not null then pg_temp.desk(v_out) end,
              case when r.status = 'cancelled' then least((r.ci - r.cancel_days) + time '16:20', now() - interval '3 hours')
                   when r.status = 'no_show' then (r.ci + time '23:47')::timestamptz end,
              case when r.status = 'cancelled' then pg_temp.ref('staff:meera') when r.status = 'no_show' then pg_temp.ref('staff:vikram') end,
              case when r.status = 'cancelled' then pg_temp.pick(array['Change of travel plans', 'Meeting postponed', 'Booked elsewhere', 'Family emergency'])
                   when r.status = 'no_show' then 'No-show at night audit for ' || r.ci else '' end,
              v_pen,
              r.pickup is not null, case when r.pickup is not null then r.ci + coalesce(r.eta, time '15:30') - interval '45 minutes' end, coalesce(r.pickup, ''),
              r.drop_at is not null, case when r.drop_at is not null then r.co + time '13:00' end, coalesce(r.drop_at, ''),
              r.stay_type, r.comp_reason,
              case when v_status <> 'tentative' then v_created + interval '2 minutes' end)
      returning id into v_id;
      update pg_temp.bk set id = v_id where n = r.n;
      v_ok := v_ok + 1;
    exception when others then
      if r.key <> 'auto' then raise; end if;
      update pg_temp.bk set skipped = sqlerrm where n = r.n;
      v_skip := v_skip + 1;
    end;
  end loop;
  raise notice 'demo: % stays placed, % skipped (capacity)', v_ok, v_skip;
end $$;
delete from pg_temp.bk where id is null;
insert into demo_seed.ref select 'bk:' || key, id from pg_temp.bk where key <> 'auto' and key not like 'grp2-%';

-- Corporate split folios: room and tax to the company, extras on the guest's master.
insert into folios (booking_id, kind, label, company_id, created_by, created_at)
select b.id, 'split', 'Company — room & tax', pg_temp.ref('co:' || b.company), pg_temp.admin(), pg_temp.ts(b.ci, b.ci_time)
  from pg_temp.bk b where b.corp_split and b.status in ('checked_in', 'checked_out');
-- Every stay has its master folio from the first line posted; make them now, dated with the stay.
insert into folios (booking_id, kind, label, created_at)
select id, 'master', 'Master', (select created_at from bookings where bookings.id = bk.id) from pg_temp.bk
on conflict do nothing;

-- Deposits taken when the booking was made.
do $$
declare r record; v_amt numeric; v_at timestamptz;
begin
  for r in select b.*, bo.total_amount, bo.created_at as made, bo.reference from pg_temp.bk b join bookings bo on bo.id = b.id
            where b.deposit <> 0 loop
    v_amt := case when r.deposit = -1 then r.total_amount when r.deposit < 0 then round(r.total_amount * -r.deposit, -2) else r.deposit end;
    v_at := least(r.made + interval '35 minutes', now() - interval '1 hour');
    perform pg_temp.post(r.id, 'payment', case when r.deposit = -1 then 'Prepaid in full (advance purchase)' else 'Advance deposit' end,
                         v_amt, v_at, coalesce(pg_temp.ref_or_null('staff:meera'), pg_temp.admin()), 0, 0, null,
                         coalesce(r.dep_method, 'card')::payment_method,
                         case coalesce(r.dep_method, 'card') when 'upi' then 'UPI-' || pg_temp.rnd(1000000, 9999999)
                                                             when 'bank_transfer' then 'NEFT-' || pg_temp.rnd(100000, 999999)
                                                             else 'CARD-' || pg_temp.rnd(1000, 9999) end, true);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- The month, day by day: arrivals, outlet bills, night audit, departures
-- ════════════════════════════════════════════════════════════════════════════

create function pg_temp.menu_pick(p_outlet text, p_n int) returns text[] language sql volatile as $$
  select array_agg(name) from (select name from pg_temp.menu where outlet = p_outlet order by random() limit p_n) x
$$;

-- Check-in: payment at the desk, registration card, key cards.
create function pg_temp.checkin(p_n int) returns void language plpgsql as $$
declare b record; v_at timestamptz; v_by uuid; v_amt numeric; g guests; v_room text;
begin
  select bk.*, bo.total_amount, bo.reference, bo.quoted_rate, bo.room_id into b
    from pg_temp.bk bk join bookings bo on bo.id = bk.id where bk.n = p_n;
  v_at := pg_temp.ts(b.ci, b.ci_time); v_by := pg_temp.desk(v_at);
  select * into g from guests where id = pg_temp.ref('guest:' || b.guest);
  if b.pay_ci <> 0 then
    v_amt := case when b.pay_ci = -1 then round(b.total_amount / (b.co - b.ci)) when b.pay_ci < 0 then round(b.total_amount * -b.pay_ci, -2) else b.pay_ci end;
    perform pg_temp.post(b.id, 'payment', 'Payment at check-in', v_amt, v_at, v_by, 0, 0, null,
                         coalesce(b.ci_method, 'card')::payment_method,
                         case when b.ci_method = 'cash' then '' else upper(coalesce(b.ci_method, 'card')) || '-' || pg_temp.rnd(100000, 999999) end, true);
  end if;
  insert into registration_cards (booking_id, guest_name, address, nationality, phone, email, arriving_from, next_destination,
                                  purpose_of_visit, accompanying, terms_accepted, signed_at, created_by, created_at)
  values (b.id, g.full_name, g.address, g.nationality, coalesce(g.phone, ''), coalesce(g.email, ''), g.city,
          pg_temp.pick(array['Mumbai', 'Home', 'Bengaluru', 'Goa', 'Home', 'New Delhi']),
          case when b.company is not null then 'Business' when b.grp is not null then 'Conference' else pg_temp.pick(array['Leisure', 'Leisure', 'Business', 'Family function']) end,
          case when b.adults > 1 then (b.adults - 1) || ' adult(s)' else '' end, true, v_at, v_by, v_at)
  on conflict (booking_id) do nothing;
  select room_number into v_room from rooms where id = b.room_id;
  insert into key_card_events (booking_id, room_id, action, cards, provider, status, response, created_by, created_at)
  values (b.id, b.room_id, 'issue', case when b.adults > 1 then 2 else 1 end, 'none', 'skipped', 'No lock system connected', v_by, v_at);
end $$;

-- Check-out: settle each folio, issue its tax invoice, push company bills to the city ledger.
create function pg_temp.checkout(p_n int) returns void language plpgsql as $$
declare
  b record; v_at timestamptz; v_by uuid; f record; v_bal numeric; v_co companies; g guests; v_inv uuid;
  v_room_part numeric; v_rate numeric; v_entry uuid; v_ledger uuid; v_invno text;
begin
  select bk.*, bo.reference, bo.status as cur_status into b from pg_temp.bk bk join bookings bo on bo.id = bk.id where bk.n = p_n;
  v_at := pg_temp.ts(b.co, b.co_time); v_by := pg_temp.desk(v_at);
  select * into g from guests where id = pg_temp.ref('guest:' || b.guest);
  if b.company is not null then select * into v_co from companies where id = pg_temp.ref('co:' || b.company); end if;

  for f in select * from folios where booking_id = b.id order by (kind = 'master') desc, created_at loop
    v_bal := folio_balance_of(f.id);
    if v_bal <= 0.005 then continue; end if;
    if f.company_id is not null then
      if not b.city_ledger then
        perform pg_temp.post(b.id, 'payment', 'Settlement at check-out', v_bal, v_at, v_by, 0, 0, null, 'bank_transfer',
                             'NEFT-' || pg_temp.rnd(100000, 999999), false, f.id);
      end if;
    elsif b.fx is not null then
      select rate_to_base into v_rate from currencies where code = b.fx;
      perform pg_temp.post(b.id, 'payment', 'Settlement at check-out', v_bal, v_at, v_by, 0, 0, null, 'card',
                           'CARD-' || pg_temp.rnd(1000, 9999), false, f.id, null, b.fx, round(v_bal / v_rate, 2), v_rate);
    elsif b.settle = 'ota_prepaid' then
      select coalesce(sum(amount + tax_amount), 0) into v_room_part from folio_entries where folio_id = f.id and kind = 'room';
      v_room_part := least(v_room_part, v_bal);
      perform pg_temp.post(b.id, 'payment', 'Prepaid through the OTA', v_room_part, v_at, v_by, 0, 0, null, 'ota_prepaid',
                           'OTA-' || pg_temp.rnd(10000000, 99999999), false, f.id);
      if v_bal - v_room_part > 0.005 then
        perform pg_temp.post(b.id, 'payment', 'Settlement at check-out', v_bal - v_room_part, v_at, v_by, 0, 0, null,
                             pg_temp.pick(array['card', 'upi'])::payment_method, 'POS-' || pg_temp.rnd(100000, 999999), false, f.id);
      end if;
    else
      perform pg_temp.post(b.id, 'payment', 'Settlement at check-out', v_bal, v_at, v_by, 0, 0, null,
                           (case when b.settle in ('bank_transfer', 'corporate_billing') then 'card' else b.settle end)::payment_method,
                           case when b.settle = 'cash' then '' else 'POS-' || pg_temp.rnd(100000, 999999) end, false, f.id);
    end if;
  end loop;

  -- Invoices: every folio with a paid-for charge, in the order first charged (foliosToInvoice).
  for f in select fo.*, min(e.created_at) as first_at from folios fo join folio_entries e on e.folio_id = fo.id
            where fo.booking_id = b.id and e.voided_at is null and e.kind in ('room', 'fee', 'penalty', 'extra')
              and e.amount + e.tax_amount > 0
            group by fo.id order by min(e.created_at) loop
    if f.company_id is not null or (b.company is not null and not b.corp_split) then
      v_inv := pg_temp.issue_invoice(f.id, v_co.name, v_co.gstin, v_co.billing_address, v_at + interval '2 minutes', v_by);
    else
      v_inv := pg_temp.issue_invoice(f.id, g.full_name, '', g.address, v_at + interval '2 minutes', v_by);
    end if;
    -- city_ledger_transfer, an hour later from the back office.
    if f.company_id is not null and b.city_ledger then
      v_bal := folio_balance_of(f.id);
      select number into v_invno from invoices where id = v_inv;
      v_entry := pg_temp.post(b.id, 'payment', 'Transferred to city ledger — ' || v_co.name, v_bal,
                              v_at + interval '1 hour', pg_temp.ref('staff:nikhil'), 0, 0, null, 'corporate_billing', coalesce(v_invno, ''), false, f.id);
      insert into city_ledger_entries (company_id, kind, amount, description, booking_id, folio_id, invoice_id, folio_entry_id,
                                       due_date, created_by, created_at)
      values (v_co.id, 'charge', v_bal, 'Stay ' || b.reference || ' — ' || f.label, b.id, f.id, v_inv, v_entry,
              b.co + v_co.payment_terms_days, pg_temp.ref('staff:nikhil'), v_at + interval '1 hour')
      returning id into v_ledger;
      update folio_entries set reference = concat_ws(' ', nullif(reference, ''), '#' || left(v_ledger::text, 8)) where id = v_entry;
    end if;
  end loop;

  insert into key_card_events (booking_id, room_id, action, cards, provider, status, response, created_by, created_at)
  select b.id, room_id, 'revoke', 1, 'none', 'skipped', 'No lock system connected', v_by, v_at from bookings where id = b.id and room_id is not null;

  if b.cur_status = 'checked_in' then
    -- Leaving today: the trigger frees the room and makes the check-out clean.
    update bookings set status = 'checked_out', checked_out_at = v_at, checked_out_by = v_by where id = b.id;
  end if;
end $$;

-- Housekeeping after a past departure: cleaned, inspected, amenities used.
create function pg_temp.hk_past(p_room uuid, p_day date, p_kind text default 'checkout') returns void language plpgsql as $$
declare v_id uuid; v_by uuid; v_start timestamptz; v_check jsonb; v_loc uuid := pg_temp.ref('loc:housekeeping');
begin
  v_by := case when (select floor from rooms where id = p_room) <= 2
               then pg_temp.pick(array[pg_temp.ref('staff:ramesh')::text, pg_temp.ref('staff:imran')::text])::uuid
               else pg_temp.ref('staff:lakshmi') end;
  v_start := p_day + make_time(pg_temp.rnd(11, 14), pg_temp.rnd(0, 59), 0);
  select jsonb_agg(jsonb_build_object('item_id', id, 'label', label, 'category', category, 'done', true,
                                      'qty', case when category = 'amenities' then 2 when category = 'linen' then par_qty else 0 end) order by sort_order)
    into v_check from hk_checklist_items where property_id = pg_temp.prop() and is_active;
  insert into housekeeping_tasks (room_id, task_date, kind, status, priority, assigned_to, assigned_at, target_minutes,
                                  started_at, completed_at, completed_by, inspected_at, inspected_by, checklist, created_by, created_at)
  values (p_room, p_day, p_kind, 'inspected', 'normal', v_by, v_start - interval '40 minutes',
          case when p_kind = 'deep_clean' then 90 else 30 end, v_start, v_start + make_interval(mins => pg_temp.rnd(22, 45)), v_by,
          v_start + interval '70 minutes', pg_temp.ref('staff:sunita'), v_check, pg_temp.ref('staff:sunita'), v_start - interval '45 minutes')
  returning id into v_id;
  insert into inventory_movements (item_id, location_id, kind, qty, unit_cost, reason, reference, created_by, created_at)
  select ii.id, v_loc, 'consume', -2, ii.unit_cost, 'Room ' || (select room_number from rooms where id = p_room),
         'HK ' || left(v_id::text, 8), v_by, v_start + interval '40 minutes'
    from inventory_items ii join pg_temp.inv i on pg_temp.ref('inv:' || i.sku) = ii.id
   where i.hk is not null;
end $$;

do $$
declare
  T date := pg_temp.today(); d date; b record; n int; v_at timestamptz; v_fb int := 0;
begin
  for d in select generate_series(T - 30, T, interval '1 day')::date loop
    -- Morning: departures.
    for b in select bk.n, bk.id, bk.room, bk.guest from pg_temp.bk bk
              where bk.co = d and (bk.status = 'checked_out' or bk.scenario = 'left_today') order by bk.co_time loop
      perform pg_temp.checkout(b.n);
      if d < T and b.room is not null then perform pg_temp.hk_past(pg_temp.ref('room:' || b.room), d); end if;
      if d < T and random() < 0.3 then
        insert into guest_feedback (booking_id, guest_id, token, requested_at, submitted_at, overall, room, service, cleanliness, food,
                                    comment, source, created_at)
        select b.id, pg_temp.ref('guest:' || b.guest), encode(gen_random_bytes(16), 'hex'), (d + time '18:00'), (d + 1 + time '09:30'),
               s.o, greatest(1, least(5, s.o + pg_temp.rnd(-1, 0))), greatest(1, least(5, s.o + pg_temp.rnd(-1, 1))),
               greatest(1, least(5, s.o + pg_temp.rnd(-1, 0))), greatest(1, least(5, s.o + pg_temp.rnd(-1, 1))),
               case s.o when 5 then pg_temp.pick(array['Wonderful stay — the front desk team went out of their way.', 'Spotless room and a superb breakfast spread.', 'Loved the lake view and the quiet. Will be back.'])
                        when 4 then pg_temp.pick(array['Good stay overall. Wi-Fi was a little slow in the evening.', 'Comfortable room, check-in took a while.', 'Nice food, the gym could open earlier.'])
                        when 3 then 'Room was fine but the AC was noisy and housekeeping came late.'
                        else 'Hot water ran out in the morning and nobody followed up. Disappointed.' end,
               'guest', (d + 1 + time '09:30')
          from (select case when random() < 0.5 then 5 when random() < 0.7 then 4 when random() < 0.7 then 3 else 2 end as o) s
        on conflict (booking_id) do nothing;
      end if;
    end loop;

    -- Afternoon: arrivals.
    for b in select bk.n from pg_temp.bk bk
              where bk.ci = d and (bk.status in ('checked_in', 'checked_out') or bk.scenario = 'left_today') order by bk.ci_time loop
      perform pg_temp.checkin(b.n);
    end loop;

    exit when d = T;   -- today's outlets and audit happen live, below

    -- The outlets: walk-in diners, and in-house guests charging to the room.
    for n in 1..pg_temp.rnd(2, 4) loop
      perform pg_temp.pos_bill('RST', d + make_time(pg_temp.rnd(12, 14), pg_temp.rnd(0, 59), 0), pg_temp.menu_pick('RST', pg_temp.rnd(2, 4)),
                               array[1, 1, 2, 1]::numeric[], pg_temp.pick(array['cash', 'card', 'upi', 'card']), null,
                               'T' || pg_temp.rnd(1, 18), pg_temp.rnd(1, 4), '', pg_temp.ref('staff:kavita'));
    end loop;
    for n in 1..pg_temp.rnd(2, 5) loop
      perform pg_temp.pos_bill('RST', d + make_time(pg_temp.rnd(19, 22), pg_temp.rnd(0, 59), 0), pg_temp.menu_pick('RST', pg_temp.rnd(3, 5)),
                               array[1, 2, 1, 1, 2]::numeric[], pg_temp.pick(array['cash', 'card', 'upi', 'card']), null,
                               'T' || pg_temp.rnd(1, 18), pg_temp.rnd(2, 6), '', pg_temp.ref('staff:kavita'));
    end loop;
    for n in 1..pg_temp.rnd(1, 3) loop
      perform pg_temp.pos_bill('BAR', d + make_time(pg_temp.rnd(19, 22), pg_temp.rnd(0, 59), 0), pg_temp.menu_pick('BAR', pg_temp.rnd(2, 3)),
                               array[2, 1, 1]::numeric[], pg_temp.pick(array['cash', 'card', 'upi']), null,
                               'B' || pg_temp.rnd(1, 8), pg_temp.rnd(1, 4), '', pg_temp.ref('staff:kavita'));
    end loop;
    if random() < 0.35 then
      perform pg_temp.pos_bill('SPA', d + make_time(pg_temp.rnd(11, 18), 0, 0), pg_temp.menu_pick('SPA', 1), array[1]::numeric[],
                               'card', null, '', 1, pg_temp.pick(array['Walk-in spa guest', 'Day pass guest']), pg_temp.ref('staff:kavita'));
    end if;

    for b in select bk.* from pg_temp.bk bk
              where bk.ci <= d and bk.co > d and (bk.status in ('checked_in', 'checked_out') or bk.scenario = 'left_today') loop
      if random() < 0.30 then
        perform pg_temp.pos_bill('RST', d + make_time(pg_temp.rnd(19, 22), pg_temp.rnd(0, 59), 0), pg_temp.menu_pick('RST', pg_temp.rnd(2, 4)),
                                 array[1, 1, 2, 1]::numeric[], 'room', b.id, 'T' || pg_temp.rnd(1, 18), b.adults, '', pg_temp.ref('staff:kavita'));
      end if;
      if random() < 0.18 then
        perform pg_temp.pos_bill('RMS', d + make_time(pg_temp.rnd(21, 23), pg_temp.rnd(0, 30), 0), pg_temp.menu_pick('RMS', pg_temp.rnd(1, 2)),
                                 array[1, 1]::numeric[], 'room', b.id, '', b.adults, '', pg_temp.desk(d + time '22:00'));
      end if;
      if random() < 0.22 then
        perform pg_temp.pos_bill('MIN', d + time '11:30' + make_interval(mins => pg_temp.rnd(0, 120)), pg_temp.menu_pick('MIN', pg_temp.rnd(1, 3)),
                                 array[1, 2, 1]::numeric[], 'room', b.id, '', 1, '', pg_temp.ref('staff:sunita'));
      end if;
      if random() < 0.12 then
        perform pg_temp.pos_bill('BAR', d + make_time(pg_temp.rnd(19, 22), pg_temp.rnd(0, 59), 0), pg_temp.menu_pick('BAR', 2),
                                 array[2, 1]::numeric[], 'room', b.id, 'B' || pg_temp.rnd(1, 8), b.adults, '', pg_temp.ref('staff:kavita'));
      end if;
      if random() < 0.08 or (b.key = 'long' and random() < 0.4) then
        perform pg_temp.pos_bill('LDY', d + time '09:30', pg_temp.menu_pick('LDY', pg_temp.rnd(1, 3)), array[3, 2, 1]::numeric[],
                                 'room', b.id, '', 1, '', pg_temp.ref('staff:ramesh'));
      end if;
      if random() < 0.05 or (b.key = 'long' and random() < 0.3) then
        perform pg_temp.pos_bill('SPA', d + time '16:00', pg_temp.menu_pick('SPA', 1), array[1]::numeric[],
                                 'room', b.id, '', 1, '', pg_temp.ref('staff:kavita'));
      end if;
    end loop;

    -- Night audit: tonight's room charges, no-shows, then close the day.
    v_at := d + time '23:46';
    for b in select bk.* from pg_temp.bk bk
              where bk.ci <= d and bk.co > d and (bk.status in ('checked_in', 'checked_out') or bk.scenario = 'left_today') loop
      perform pg_temp.post_night(b.id, d, v_at, pg_temp.ref('staff:vikram'), d,
                                 (select id from folios where booking_id = b.id and company_id is not null limit 1));
    end loop;
    for b in select bk.*, bo.penalty_amount, bo.quoted_rate from pg_temp.bk bk join bookings bo on bo.id = bk.id
              where bk.ci = d and bk.status = 'no_show' loop
      perform pg_temp.post(b.id, 'penalty', 'No-show: first night charged.', a.net, v_at + interval '1 minute', pg_temp.ref('staff:vikram'),
                           a.tax, a.rate, null, null, '', false, null, d)
         from pg_temp.ancillary(b.penalty_amount, pg_temp.nightly(b.id, b.ci)) a;
    end loop;
    perform pg_temp.close_day(d);
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- People: roster, attendance, leave, timesheets
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  T date := pg_temp.today(); v_mon date := date_trunc('week', pg_temp.today())::date; s record; d date;
  v_shift shift_types; v_in timestamptz; v_out timestamptz; v_late int; v_type uuid; v_alt text;
begin
  -- Roster: last week and this week. Front desk swap mornings and afternoons weekly.
  for s in select st.id, st.weekly_off, st.default_shift_id, st.email, r.key
             from staff st join demo_seed.ref r on r.id = st.id where r.key like 'staff:%' loop
    for d in select generate_series(v_mon - 7, v_mon + 6, interval '1 day')::date loop
      if extract(dow from d) = s.weekly_off then
        v_type := null;
      elsif s.key in ('staff:ankit', 'staff:sneha') then
        v_alt := case when (extract(week from d)::int % 2 = 0) = (s.key = 'staff:ankit') then 'Morning' else 'Afternoon' end;
        select id into v_type from shift_types where property_id = pg_temp.prop() and name = v_alt;
      else
        v_type := s.default_shift_id;
      end if;
      insert into staff_shifts (staff_id, shift_date, shift_type_id, notes, updated_by, updated_at)
      values (s.id, d, v_type, '', pg_temp.ref('staff:priya'), (v_mon - 10) + time '17:00')
      on conflict (staff_id, shift_date) do nothing;
    end loop;
  end loop;

  -- Approved leave: Lakshmi next week (so the roster shows it), Imran earlier this month.
  insert into leave_requests (staff_id, kind, start_date, end_date, reason, status, decided_by, decided_at, decision_note, created_at) values
   (pg_temp.ref('staff:lakshmi'), 'casual', T + 3, T + 5, 'Sister''s wedding in Thrissur', 'approved', pg_temp.ref('staff:sunita'), (T - 6) + time '10:15', 'Approved — Imran covers floors 3 & 4', (T - 8) + time '18:20'),
   (pg_temp.ref('staff:imran'), 'sick', T - 12, T - 11, 'Viral fever, doctor''s note attached', 'approved', pg_temp.ref('staff:sunita'), (T - 12) + time '08:05', '', (T - 12) + time '07:10'),
   (pg_temp.ref('staff:ankit'), 'earned', T + 15, T + 18, 'Family trip to Manali', 'pending', null, null, '', (T - 1) + time '21:40'),
   (pg_temp.ref('staff:suresh'), 'casual', T + 2, T + 2, 'Bank work', 'pending', null, null, '', T - 1 + time '16:05'),
   (pg_temp.ref('staff:kavita'), 'earned', T - 3, T + 1, 'Diwali at home', 'rejected', pg_temp.ref('staff:arjun'), (T - 9) + time '12:00', 'Festive week — the restaurant is fully booked. Take the week after instead.', (T - 10) + time '15:30');

  -- Attendance for the last 13 days and this morning, from the roster (or default shift).
  for s in select st.id, st.weekly_off, st.default_shift_id, r.key
             from staff st join demo_seed.ref r on r.id = st.id where r.key like 'staff:%' loop
    for d in select generate_series(T - 13, T, interval '1 day')::date loop
      continue when extract(dow from d) = s.weekly_off;
      continue when exists (select 1 from leave_requests l where l.staff_id = s.id and l.status = 'approved' and d between l.start_date and l.end_date);
      select st.* into v_shift from shift_types st
       where st.id = coalesce((select shift_type_id from staff_shifts where staff_id = s.id and shift_date = d), s.default_shift_id);
      continue when v_shift.id is null;
      v_late := case when random() < 0.12 then pg_temp.rnd(12, 35) else pg_temp.rnd(-12, 6) end;
      v_in := (d + v_shift.start_time) + make_interval(mins => v_late);
      v_out := (d + v_shift.end_time + case when v_shift.end_time <= v_shift.start_time then interval '1 day' else interval '0' end)
               + make_interval(mins => case when random() < 0.2 then pg_temp.rnd(45, 110) else pg_temp.rnd(0, 20) end);
      continue when v_in > now() - interval '5 minutes';
      if v_out > now() then v_out := null; end if;
      insert into attendance (staff_id, work_date, clock_in, clock_out, method, in_distance_m, out_distance_m, notes, recorded_by, created_at)
      values (s.id, d, v_in, v_out, case when s.key in ('staff:ramesh', 'staff:lakshmi', 'staff:imran', 'staff:suresh') then 'biometric' else 'mobile' end,
              pg_temp.rnd(5, 60), case when v_out is not null then pg_temp.rnd(5, 60) end,
              case when v_late > 15 then 'Late — traffic on the ring road' else '' end, s.id, v_in);
    end loop;
  end loop;
  -- Forgot to clock out yesterday: corrected by the manager.
  update attendance set notes = 'Clock-out added by manager — forgot to clock out', recorded_by = pg_temp.ref('staff:priya')
   where id = (select id from attendance where staff_id = pg_temp.ref('staff:sneha') and work_date = T - 2 limit 1);
end $$;

-- Timesheets for last week: Ankit's is submitted, Sneha's approved by the GM.
do $$
declare
  v_week date := date_trunc('week', pg_temp.today())::date - 7; s text; v_days jsonb; v_reg numeric; v_ot numeric; v_off numeric;
begin
  foreach s in array array['ankit', 'sneha', 'vikram'] loop
    select jsonb_agg(jsonb_build_object(
             'date', d::date, 'shift', coalesce(st.name, case when sh.staff_id is not null then 'Off' else '' end),
             'scheduled', case when st.id is not null then 8 else 0 end,
             'worked', coalesce(round(extract(epoch from a.clock_out - a.clock_in) / 3600.0, 2), 0),
             'regular', least(coalesce(round(extract(epoch from a.clock_out - a.clock_in) / 3600.0, 2), 0), 9),
             'overtime', greatest(coalesce(round(extract(epoch from a.clock_out - a.clock_in) / 3600.0, 2), 0) - 9, 0),
             'off_day', 0, 'leave', null,
             'late', coalesce(a.clock_in > d::date + st.start_time + interval '10 minutes', false)) order by d)
      into v_days
      from generate_series(v_week, v_week + 6, interval '1 day') d
      left join staff_shifts sh on sh.staff_id = pg_temp.ref('staff:' || s) and sh.shift_date = d::date
      left join shift_types st on st.id = sh.shift_type_id
      left join attendance a on a.staff_id = pg_temp.ref('staff:' || s) and a.work_date = d::date;
    select sum((x->>'regular')::numeric), sum((x->>'overtime')::numeric), sum((x->>'off_day')::numeric)
      into v_reg, v_ot, v_off from jsonb_array_elements(v_days) x;
    perform pg_temp.act(pg_temp.ref('staff:' || s));
    perform timesheet_submit(v_week, case s when 'vikram' then 'Covered an extra night on Saturday' else '' end, v_reg, v_ot, v_off, v_days);
    update timesheets set submitted_at = (v_week + 7) + time '09:15'
     where staff_id = pg_temp.ref('staff:' || s) and week_start = v_week;
    if s = 'sneha' then
      perform pg_temp.act(pg_temp.ref('staff:rajesh'));
      perform timesheet_decide(pg_temp.ref('staff:sneha'), v_week, true, 'Checked against the roster', v_reg, v_ot, v_off, v_days);
      update timesheets set decided_at = (v_week + 7) + time '16:40'
       where staff_id = pg_temp.ref('staff:sneha') and week_start = v_week;
    end if;
  end loop;
  perform pg_temp.act(pg_temp.admin());
end $$;

insert into staff_feedback (staff_id, booking_id, rating, comment, source, recorded_by, created_at) values
 (pg_temp.ref('staff:ankit'), pg_temp.ref('bk:cn'), 5, 'Ankit sorted out our room change at midnight without any fuss.', 'guest', pg_temp.ref('staff:pooja'), (pg_temp.today() - 3) + time '12:00'),
 (pg_temp.ref('staff:lakshmi'), null, 5, 'Room was spotless, and she remembered our extra pillows every day.', 'guest', pg_temp.ref('staff:pooja'), (pg_temp.today() - 6) + time '11:00'),
 (pg_temp.ref('staff:kavita'), null, 4, 'Quick billing during the Sunday brunch rush.', 'manager', pg_temp.ref('staff:arjun'), (pg_temp.today() - 4) + time '17:00'),
 (pg_temp.ref('staff:sneha'), pg_temp.ref('bk:b2b-pay'), 3, 'Check-out took long because the company invoice address was wrong.', 'manager', pg_temp.ref('staff:priya'), (pg_temp.today() - 12) + time '15:00');

-- ════════════════════════════════════════════════════════════════════════════
-- Cash shifts: the last five days closed, today's open
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  T date := pg_temp.today(); d date; w record; v_id uuid; v_exp numeric; v_var numeric;
begin
  for d in select generate_series(T - 5, T - 1, interval '1 day')::date loop
    for w in select * from (values
               (pg_temp.desk(d + time '10:00'), d + time '06:55', d + time '15:10', 5000),
               (pg_temp.desk(d + time '18:00'), d + time '14:55', d + time '23:10', 5000),
               (pg_temp.ref('staff:kavita'), d + time '11:25', d + time '23:40', 3000)) x (staff, opened, closed, flt) loop
      insert into cashier_shifts (staff_id, opened_at, opening_float) values (w.staff, w.opened, w.flt) returning id into v_id;
      update folio_entries set shift_id = v_id
       where property_id = pg_temp.prop() and method = 'cash' and kind in ('payment', 'refund') and shift_id is null
         and created_by = w.staff and created_at between w.opened and w.closed;
      update pos_payments set shift_id = v_id
       where property_id = pg_temp.prop() and kind = 'cash' and shift_id is null
         and created_by = w.staff and created_at between w.opened and w.closed;
      if w.staff = pg_temp.ref('staff:kavita') and cashier_shift_expected(v_id) > 8000 then
        insert into cash_movements (shift_id, kind, amount, reason, created_by, created_at)
        values (v_id, 'safe_drop', round((cashier_shift_expected(v_id) - w.flt) * 0.8, -3), 'Drop to the main safe', w.staff, d + time '23:20');
      end if;
      if w.staff <> pg_temp.ref('staff:kavita') and d = T - 4 and w.opened::time < time '12:00' then
        insert into cash_movements (shift_id, kind, amount, reason, created_by, created_at)
        values (v_id, 'paid_out', 450, 'Courier charges for a guest''s parcel', w.staff, d + time '12:40');
      end if;
      v_exp := cashier_shift_expected(v_id);
      v_var := case when d = T - 3 and w.flt = 3000 then -200 when d = T - 1 and w.flt = 5000 then 50 else 0 end;
      update cashier_shifts set closed_at = w.closed, closed_by = w.staff, expected_cash = v_exp,
             counted_cash = v_exp + v_var, variance = v_var,
             notes = case when v_var < 0 then 'Short by ₹200 — change given twice at the bar, reported to F&B manager'
                          when v_var > 0 then 'Over by ₹50, kept in the float envelope' else '' end
       where id = v_id;
    end loop;
  end loop;
end $$;

-- Today: the desk agent on duty and the restaurant cashier open their shifts.
do $$
declare v_desk uuid := pg_temp.desk(now()); v_id uuid;
begin
  perform pg_temp.act(v_desk);
  v_id := cashier_open_shift(5000);
  update cashier_shifts set opened_at = pg_temp.ts(pg_temp.today(), case when extract(hour from now()) >= 15 and extract(hour from now()) < 23 then time '14:55' else time '06:55' end) where id = v_id;
  update folio_entries set shift_id = v_id
   where property_id = pg_temp.prop() and method = 'cash' and kind in ('payment', 'refund') and shift_id is null
     and created_by = v_desk and created_at >= pg_temp.today()::timestamptz;
  perform pg_temp.setref('shift:desk', v_id);
  -- A paid-out charged to an in-house guest (posts "Paid out: ..." on the folio).
  perform cashier_cash_movement('paid_out', 380, 'Pharmacy delivery for room 403', pg_temp.ref('bk:long'));

  perform pg_temp.act(pg_temp.ref('staff:kavita'));
  v_id := cashier_open_shift(3000);
  update cashier_shifts set opened_at = pg_temp.ts(pg_temp.today(), time '11:25') where id = v_id;
  perform pg_temp.act(pg_temp.admin());
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Today at the outlets, through the app's own functions
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare
  o uuid; v_out uuid; i text; v_owe numeric;
  function_items text[];
begin
  perform pg_temp.act(pg_temp.ref('staff:kavita'));
  -- Lunch still at the table, kitchen ticket sent.
  v_out := (select id from pos_outlets where code = 'RST' and property_id = pg_temp.prop());
  o := pos_open_order(v_out, 'T7', null, null, 'Mr. Deshpande', 4);
  foreach i in array array['Paneer Tikka', 'Dal Makhani', 'Butter Naan', 'Butter Naan', 'Jeera Rice', 'Fresh Lime Soda'] loop
    perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = i), 1);
  end loop;
  perform pos_send_kot(o);
  -- A settled cash lunch.
  o := pos_open_order(v_out, 'T2', null, null, '', 2);
  foreach i in array array['Veg Manchow Soup', 'Chicken Dum Biryani', 'Masala Chai'] loop
    perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = i), 1);
  end loop;
  perform pos_send_kot(o);
  perform pos_take_payment(o, 'cash', pos_order_balance(o), '');
  -- Room service charged to the long-stay guest.
  v_out := (select id from pos_outlets where code = 'RMS' and property_id = pg_temp.prop());
  o := pos_open_order(v_out, '', pg_temp.ref('room:403'), pg_temp.ref('bk:long'), '', 1);
  perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = 'Club Sandwich'), 1);
  perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = 'Hot Chocolate'), 1);
  perform pos_send_kot(o);
  perform pos_charge_to_room(o, pg_temp.ref('bk:long'), null);
  -- Bar tab with part paid (status "billed").
  v_out := (select id from pos_outlets where code = 'BAR' and property_id = pg_temp.prop());
  o := pos_open_order(v_out, 'B3', null, null, 'Pool deck', 3);
  perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = 'Classic Mojito'), 2);
  perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = 'Chicken 65'), 1);
  perform pos_send_kot(o);
  perform pos_take_payment(o, 'card', round(pos_order_balance(o) / 2), 'CARD-4471');
  -- Laundry collected from a room, being processed.
  v_out := (select id from pos_outlets where code = 'LDY' and property_id = pg_temp.prop());
  o := pos_open_order(v_out, '', pg_temp.ref('room:302'), pg_temp.ref('bk:arr-in'), '', 1);
  perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = 'Shirt — wash & iron'), 3);
  perform pos_add_line(o, (select id from pos_items where outlet_id = v_out and name = 'Saree — dry clean'), 1);
  perform pos_set_laundry_status(o, 'processing');
  perform pg_temp.act(pg_temp.admin());
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Billing: a credit note and its refund; a refund waiting for approval
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare v_inv invoices; v_cn credit_notes; v_req uuid; v_entry uuid; v_line numeric;
begin
  select * into v_inv from invoices where booking_id = pg_temp.ref('bk:cn') and status = 'issued' order by issued_at limit 1;
  v_line := (v_inv.lines->0->>'total')::numeric;
  perform pg_temp.act(pg_temp.ref('staff:nikhil'));
  v_cn := credit_note_issue(v_inv.id, 'deficiency',
            'AC in room 307 failed on the first night; the GM waived that night.',
            jsonb_build_array(jsonb_build_object('line', 0, 'amount', v_line)));
  -- Front desk asks for the money back; the GM approves (above the threshold); paid to the card.
  perform pg_temp.act(pg_temp.ref('staff:ankit'));
  insert into refund_requests (booking_id, folio_id, amount, reason, method, requested_by)
  values (pg_temp.ref('bk:cn'), v_inv.folio_id, v_cn.grand_total, 'Credit note ' || v_cn.number || ' — night waived for AC failure', 'card',
          pg_temp.ref('staff:ankit'))
  returning id into v_req;
  perform pg_temp.act(pg_temp.ref('staff:rajesh'));
  update refund_requests set status = 'approved', decided_by = pg_temp.ref('staff:rajesh'), decided_at = now(),
         decision_note = 'Approved — apologise to the guest on my behalf' where id = v_req;
  v_entry := pg_temp.post(pg_temp.ref('bk:cn'), 'refund', 'Refund — Credit note ' || v_cn.number || ' — night waived for AC failure',
                          v_cn.grand_total, now(), pg_temp.ref('staff:rajesh'), 0, 0, null, 'card', '', false, v_inv.folio_id);
  update refund_requests set status = 'processed', processed_at = now(), folio_entry_id = v_entry, error = '' where id = v_req;

  -- The cancelled stay's deposit: asked for, waiting for a manager.
  perform pg_temp.act(pg_temp.ref('staff:meera'));
  insert into refund_requests (booking_id, amount, reason, method, requested_by, requested_at)
  values (pg_temp.ref('bk:cxl-dep'), 6000, 'Cancelled within the free-cancellation window — return the deposit', 'upi',
          pg_temp.ref('staff:meera'), now() - interval '20 hours');
  perform pg_temp.act(pg_temp.admin());

  -- A company pays part of what it owes on account.
  insert into city_ledger_entries (company_id, kind, amount, description, method, reference, created_by, created_at)
  select pg_temp.ref('co:zenith'), 'payment', round(sum(amount) * 0.6, -3), 'Part payment against statement', 'bank_transfer',
         'NEFT-ZEN-' || to_char(pg_temp.today() - 2, 'DDMM'), pg_temp.ref('staff:nikhil'), (pg_temp.today() - 2) + time '15:30'
    from city_ledger_entries where company_id = pg_temp.ref('co:zenith') and kind = 'charge'
  having sum(amount) > 0;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Front desk: traces, requests, notes, a room move, transport
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare T date := pg_temp.today();
begin
  insert into guest_requests (booking_id, room_id, kind, description, due_at, status, created_by, created_at, completed_by, completed_at, department_id) values
   (pg_temp.ref('bk:arr-vip'), pg_temp.ref('room:402'), 'trace', 'Place champagne and anniversary cake before arrival; confirm with F&B', pg_temp.ts(T, '15:00'), 'open', pg_temp.ref('staff:priya'), (T - 1) + time '18:00', null, null,
    (select id from departments where property_id = pg_temp.prop() and name = 'Food & Beverage')),
   (pg_temp.ref('bk:dep-due1'), pg_temp.ref('room:208'), 'trace', 'Confirm airport drop at 13:00 and print boarding pass', T + time '11:30', 'open', pg_temp.ref('staff:ankit'), (T - 1) + time '20:10', null, null,
    (select id from departments where property_id = pg_temp.prop() and name = 'Front Office')),
   (pg_temp.ref('bk:arr-uk'), null, 'trace', 'Late arrival — hold the room, OTA prepaid, collect passport and visa copy', T + time '22:30', 'open', pg_temp.ref('staff:ankit'), T - 1 + time '11:00', null, null,
    (select id from departments where property_id = pg_temp.prop() and name = 'Front Office')),
   (pg_temp.ref('bk:long'), pg_temp.ref('room:403'), 'wake_up_call', 'Wake-up call 06:00', (T + 1) + time '06:00', 'open', pg_temp.desk(now()), pg_temp.ts(T, '09:00'), null, null, null),
   (pg_temp.ref('bk:grp1-1'), pg_temp.ref('room:201'), 'housekeeping', 'Two extra pillows and an ironing board', pg_temp.ts(T, '10:00'), 'done', pg_temp.ref('staff:ankit'), pg_temp.ts(T, '08:20'), pg_temp.ref('staff:ramesh'), pg_temp.ts(T, '08:50'),
    (select id from departments where property_id = pg_temp.prop() and name = 'Housekeeping')),
   (pg_temp.ref('bk:romance'), pg_temp.ref('room:404'), 'request', 'Rose petals on the bed and cake at 21:00', T + time '20:30', 'open', pg_temp.ref('staff:pooja'), (T - 1) + time '15:00', null, null,
    (select id from departments where property_id = pg_temp.prop() and name = 'Housekeeping')),
   (pg_temp.ref('bk:cn'), pg_temp.ref('room:307'), 'complaint', 'AC not cooling — guest moved to the lounge while engineering checked', (T - 5) + time '23:30', 'done', pg_temp.ref('staff:vikram'), (T - 5) + time '22:45', pg_temp.ref('staff:suresh'), (T - 4) + time '10:30',
    (select id from departments where property_id = pg_temp.prop() and name = 'Engineering')),
   (pg_temp.ref('bk:comp'), pg_temp.ref('room:401'), 'message', 'Photographer arriving at 11:00 for the property shoot — call the room', pg_temp.ts(T, '10:45'), 'done', pg_temp.ref('staff:pooja'), (T - 1) + time '19:00', pg_temp.ref('staff:pooja'), pg_temp.ts(T, '10:50'), null);
  -- A maintenance request from a guest becomes a ticket (trigger).
  insert into guest_requests (booking_id, room_id, kind, description, due_at, status, created_by, created_at)
  values (pg_temp.ref('bk:long'), pg_temp.ref('room:403'), 'maintenance', 'Bathroom tap dripping in room 403', T + time '18:00', 'open',
          pg_temp.desk(now()), pg_temp.ts(T, '08:05'));

  insert into booking_notes (booking_id, author_id, body, created_at) values
   (pg_temp.ref('bk:arr-vip'), pg_temp.ref('staff:priya'), 'Platinum member, 5th stay. Upgrade already applied — do not charge the suite difference.', (T - 2) + time '12:00'),
   (pg_temp.ref('bk:dep-due2'), pg_temp.ref('staff:nikhil'), 'Room and tax to Meridian Pharma (GSTIN on file). Guest pays incidentals.', (T - 3) + time '16:30'),
   (pg_temp.ref('bk:long'), pg_temp.ref('staff:rajesh'), 'Long-stay rate agreed with the guest; deposit received by bank transfer.', (T - 40) + time '10:00'),
   (pg_temp.ref('bk:cxl-dep'), pg_temp.ref('staff:meera'), 'Guest cancelled by phone; deposit refund requested.', now() - interval '20 hours');

  insert into room_moves (booking_id, from_room_id, to_room_id, reason, reason_code, moved_by, moved_at)
  values (pg_temp.ref('bk:dep-due1'), pg_temp.ref('room:209'), pg_temp.ref('room:208'), 'Noise from the service lift', 'noise',
          pg_temp.ref('staff:vikram'), (T - 2) + time '23:15');

  -- Pickup tomorrow for a confirmed arrival.
  update bookings set pickup_required = true, pickup_at = (T + 1) + time '10:30', pickup_details = 'Pune station — Deccan Queen, coach C4'
   where id = (select b.id from pg_temp.bk b where b.ci = T + 1 and b.status = 'confirmed' and b.key = 'auto' order by b.n limit 1);
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Housekeeping today
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare T date := pg_temp.today(); v uuid; v_check jsonb; r record; k int := 0;
begin
  perform pg_temp.act(pg_temp.ref('staff:sunita'));
  select jsonb_agg(jsonb_build_object('item_id', id, 'label', label, 'category', category, 'done', true,
                                      'qty', case when category = 'amenities' then 2 when category = 'linen' then par_qty else 0 end) order by sort_order)
    into v_check from hk_checklist_items where property_id = pg_temp.prop() and is_active;
  -- Stay-over service for the in-house rooms, in every state.
  for r in select b.room_id, ro.room_number from bookings b join rooms ro on ro.id = b.room_id
            where b.status = 'checked_in' and b.check_in < T and b.property_id = pg_temp.prop() order by ro.room_number loop
    k := k + 1;
    v := hk_create_task(r.room_id, 'stayover', T, 'Daily service');
    continue when v is null;
    if k % 4 = 1 then
      update housekeeping_tasks set status = 'in_progress', started_at = pg_temp.ts(T, '10:20') where id = v;
      update rooms set housekeeping_status = 'cleaning', housekeeping_updated_at = pg_temp.ts(T, '10:20') where id = r.room_id;
    elsif k % 4 = 2 then
      update housekeeping_tasks set status = 'in_progress', started_at = pg_temp.ts(T, '09:40') where id = v;
      -- Finished with the checklist: the trigger takes the amenities out of stock.
      update housekeeping_tasks set status = 'cleaned', completed_at = pg_temp.ts(T, '10:05'), completed_by = assigned_to, checklist = v_check where id = v;
      update rooms set housekeeping_status = 'clean', housekeeping_updated_at = pg_temp.ts(T, '10:05') where id = r.room_id;
    elsif k % 4 = 3 then
      update housekeeping_tasks set status = 'inspected', started_at = pg_temp.ts(T, '09:00'), completed_at = pg_temp.ts(T, '09:30'),
             completed_by = assigned_to, inspected_at = pg_temp.ts(T, '09:50'), inspected_by = pg_temp.ref('staff:sunita'), checklist = v_check where id = v;
    else
      update rooms set housekeeping_status = 'dirty', housekeeping_updated_at = pg_temp.ts(T, '07:00') where id = r.room_id;
    end if;
  end loop;
  -- A deep clean that has fallen due, and one that failed inspection.
  for r in select ro.id as room_id, row_number() over (order by ro.room_number) as k2 from rooms ro
            where ro.property_id = pg_temp.prop() and ro.status = 'available' and ro.housekeeping_status = 'inspected'
              and ro.id in (select id from demo_seed.ref where key like 'room:%')
              and not exists (select 1 from bookings b where b.room_id = ro.id and b.check_in = T and b.status in ('confirmed', 'tentative'))
            order by ro.room_number limit 2 loop
    if r.k2 = 1 then
      perform hk_create_task(r.room_id, 'deep_clean', T, 'Scheduled deep clean');
    else
      v := hk_create_task(r.room_id, 'touch_up', T, 'Smell of smoke reported — air and re-clean');
      update housekeeping_tasks set status = 'in_progress', started_at = pg_temp.ts(T, '09:15'), failed_count = 1,
             inspection_note = 'Ashtray smell remains — treat curtains' where id = v;
      update rooms set housekeeping_status = 'cleaning' where id = r.room_id;
    end if;
  end loop;
  -- Do-not-disturb on one room.
  update rooms set dnd = true, dnd_updated_at = pg_temp.ts(T, '08:30') where id = pg_temp.ref('room:404');

  -- Room status reports from the floor (one does not match the system).
  insert into hk_room_reports (room_id, report_date, reported, luggage, notes, reported_by, reported_at) values
   (pg_temp.ref('room:403'), T, 'occupied', true, '', pg_temp.ref('staff:lakshmi'), pg_temp.ts(T, '08:10')),
   (pg_temp.ref('room:204'), T, 'vacant', false, '', pg_temp.ref('staff:ramesh'), pg_temp.ts(T, '08:15')),
   (pg_temp.ref('room:206'), T, 'vacant', false, 'Bed not slept in, no luggage', pg_temp.ref('staff:ramesh'), pg_temp.ts(T, '08:20'));

  insert into lost_found_items (room_id, location, found_on, description, category, booking_id, found_by, storage_location, status, returned_to, resolved_at, resolved_by, notes, created_at) values
   (pg_temp.ref('room:303'), '', T, 'Grey Bose headphones in a black case, left on the bedside table', 'electronics', pg_temp.ref('bk:dep-left2'),
    pg_temp.ref('staff:lakshmi'), 'Housekeeping office, shelf B', 'stored', '', null, null, 'Guest emailed — courier to Lyon at guest''s cost', pg_temp.ts(T, '11:40')),
   (null, 'Main Restaurant', T - 9, 'Gold-plated bangle', 'jewellery', null, pg_temp.ref('staff:kavita'), 'Duty manager safe', 'returned',
    'Mrs. Pooja Shah (verified with Aadhaar)', (T - 7) + time '13:00', pg_temp.ref('staff:priya'), '', (T - 9) + time '21:40'),
   (pg_temp.ref('room:105'), '', T - 15, 'Phone charger (USB-C)', 'electronics', null, pg_temp.ref('staff:ramesh'), 'Housekeeping office, box 3', 'stored', '', null, null, 'Unclaimed after 14 days', (T - 15) + time '12:30');
  perform pg_temp.act(pg_temp.admin());
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Maintenance: assets, preventive schedules, tickets, one room out of order
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare T date := pg_temp.today(); v uuid; v_tk uuid; r record;
begin
  insert into assets (name, category, room_id, location, make, model, serial_number, installed_on, warranty_until, notes) values
   ('Central chiller unit', 'hvac', null, 'Terrace plant room', 'Blue Star', 'BS-CH200', 'BSC2019-44821', '2019-03-15', '2024-03-14', 'AMC with Blue Star till March'),
   ('Diesel generator 500 kVA', 'electrical', null, 'DG yard', 'Kirloskar', 'KG-500', 'KOEL-500-11873', '2018-08-01', null, 'Weekly no-load test on Mondays'),
   ('Passenger lift 1', 'elevator', null, 'Main lobby', 'Otis', 'Gen2 Life', 'OTIS-IN-88213', '2018-08-20', null, ''),
   ('Hot water boiler', 'boiler', null, 'Basement plant room', 'Thermax', 'Shellmax 600', 'TX-60-3381', '2018-09-10', null, ''),
   ('Commercial dishwasher', 'kitchen', null, 'Main kitchen', 'Hobart', 'AM15', 'HB-AM15-7712', '2022-01-12', '2025-01-11', ''),
   ('Washer-extractor 25 kg', 'laundry', null, 'Laundry', 'Electrolux', 'W5250H', 'EL-W5-90231', '2021-06-05', null, ''),
   ('Fire alarm panel', 'safety', null, 'Security room', 'Honeywell', 'Notifier NFS2', 'HW-NFS-1182', '2018-08-01', null, 'Monthly test with the fire officer'),
   ('Split AC — room 307', 'hvac', pg_temp.ref('room:307'), '', 'Daikin', 'FTKF50', 'DK-50-33019', '2020-04-02', '2025-04-01', ''),
   ('Split AC — room 308', 'hvac', pg_temp.ref('room:308'), '', 'Daikin', 'FTKF50', 'DK-50-33020', '2020-04-02', '2025-04-01', ''),
   ('Smart TV — room 402', 'it', pg_temp.ref('room:402'), '', 'Samsung', 'UA55', 'SM-55-77810', '2023-02-11', '2026-02-10', ''),
   ('Water pressure pump', 'plumbing', null, 'Basement', 'Grundfos', 'CR 10', 'GF-CR10-5521', '2019-11-30', null, '');

  insert into maintenance_schedules (title, description, asset_id, room_id, location, interval_days, next_due_on, priority, assigned_to, created_by, created_at) values
   ('Generator weekly test run', 'Run on load for 15 minutes, check fuel and battery', (select id from assets where serial_number = 'KOEL-500-11873'), null, 'DG yard', 7, T, 'medium', pg_temp.ref('staff:suresh'), pg_temp.ref('staff:rajesh'), (T - 120)::timestamptz),
   ('Chiller quarterly service', 'Vendor AMC visit — coil cleaning, refrigerant check', (select id from assets where serial_number = 'BSC2019-44821'), null, 'Terrace plant room', 90, T + 12, 'high', pg_temp.ref('staff:suresh'), pg_temp.ref('staff:rajesh'), (T - 200)::timestamptz),
   ('Fire alarm monthly test', 'Test every zone with the fire officer and log it', (select id from assets where serial_number = 'HW-NFS-1182'), null, 'Security room', 30, T + 20, 'high', pg_temp.ref('staff:suresh'), pg_temp.ref('staff:rajesh'), (T - 300)::timestamptz),
   ('Room AC filter cleaning', 'Clean the filters on every split unit', null, null, 'All floors', 30, T + 5, 'low', pg_temp.ref('staff:suresh'), pg_temp.ref('staff:rajesh'), (T - 150)::timestamptz),
   ('Lift monthly AMC visit', '', (select id from assets where serial_number = 'OTIS-IN-88213'), null, 'Main lobby', 30, T + 9, 'medium', null, pg_temp.ref('staff:rajesh'), (T - 90)::timestamptz);

  -- Tickets over the month.
  insert into maintenance_tickets (title, description, room_id, asset_id, location, priority, status, source, assigned_to, assigned_at,
                                   reported_by, created_at, started_at, resolved_at, resolved_by, resolution_note, hold_reason, escalated_at)
  select x.title, x.descr, case when x.room is not null then pg_temp.ref('room:' || x.room) end,
         (select id from assets where serial_number = x.serial), x.loc, x.prio, x.status, 'staff',
         case when x.status <> 'open' or x.assigned then pg_temp.ref('staff:suresh') end,
         case when x.status <> 'open' or x.assigned then (T + x.created_off) + x.at + interval '20 minutes' end,
         pg_temp.ref(x.reporter), (T + x.created_off) + x.at,
         case when x.status in ('in_progress', 'on_hold', 'resolved') then (T + x.created_off) + x.at + interval '45 minutes' end,
         case when x.status = 'resolved' then (T + x.created_off) + x.at + make_interval(hours => x.fix_h) end,
         case when x.status = 'resolved' then pg_temp.ref('staff:suresh') end,
         x.note, x.hold, case when x.escalate then (T + x.created_off) + x.at + make_interval(hours => 3) end
    from (values
      ('AC not cooling in 307', 'Guest complaint at night; gas pressure low', '307', 'DK-50-33019', '', 'high', 'resolved', -5, time '22:50', 'staff:vikram', 14, 'Topped up refrigerant, fixed a flare-joint leak', '', false, false),
      ('Shower mixer stiff', '', '104', null, '', 'low', 'resolved', -18, time '11:00', 'staff:ramesh', 30, 'Replaced cartridge', '', false, false),
      ('TV not connecting to Wi-Fi', '', '402', 'SM-55-77810', '', 'medium', 'resolved', -11, time '19:30', 'staff:sneha', 3, 'Re-paired with the in-room access point', '', false, false),
      ('Dishwasher rinse arm blocked', '', null, 'HB-AM15-7712', 'Main kitchen', 'high', 'resolved', -8, time '15:10', 'staff:arjun', 4, 'Descaled and cleared the nozzles', '', false, false),
      ('Corridor light flickering, 3rd floor', '', null, null, '3rd floor corridor', 'low', 'resolved', -14, time '20:05', 'staff:lakshmi', 20, 'Replaced driver and two LED panels', '', false, false),
      ('Lift stopping 2 cm below floor level', 'Reported by a guest in a wheelchair', null, 'OTIS-IN-88213', 'Main lobby', 'urgent', 'resolved', -20, time '09:40', 'staff:priya', 5, 'Otis re-levelled the car; logged under AMC', '', false, false),
      ('Bathroom exhaust fan noisy', '', '205', null, '', 'low', 'open', -1, time '12:30', 'staff:ramesh', 0, '', '', false, false),
      ('Washer-extractor tripping on spin', 'Laundry backlog building', null, 'EL-W5-90231', 'Laundry', 'urgent', 'open', 0, time '07:30', 'staff:sunita', 0, '', '', true, true),
      ('Door closer weak, room 102', '', '102', null, '', 'medium', 'in_progress', -2, time '16:00', 'staff:imran', 0, '', '', true, false),
      ('Boiler pressure fluctuating', 'Hot water slow on floors 3 and 4 in the morning', null, 'TX-60-3381', 'Basement plant room', 'high', 'in_progress', -1, time '07:05', 'staff:vikram', 0, '', '', true, false),
      ('Replace curtain track, room 210', '', '210', null, '', 'low', 'on_hold', -6, time '14:00', 'staff:lakshmi', 0, '', 'Waiting for the vendor to deliver a 2.4 m track', true, false)
    ) x (title, descr, room, serial, loc, prio, status, created_off, at, reporter, fix_h, note, hold, assigned, escalate);

  -- Out of order: ceiling leak in 308, blocked from today (mt_block_room).
  perform pg_temp.act(pg_temp.ref('staff:suresh'));
  insert into maintenance_tickets (title, description, room_id, priority, status, source, assigned_to, assigned_at, reported_by, created_at, started_at)
  values ('Ceiling seepage in bathroom, room 308', 'Leak from the 4th-floor drain line; false ceiling soaked. Room cannot be sold.',
          pg_temp.ref('room:308'), 'high', 'in_progress', 'staff', pg_temp.ref('staff:suresh'), pg_temp.ts(T, '08:05'),
          pg_temp.ref('staff:lakshmi'), pg_temp.ts(T, '07:50'), pg_temp.ts(T, '08:20'))
  returning id into v_tk;
  perform mt_block_room(v_tk);
  update room_blocks set end_date = T + 3 where ticket_id = v_tk;
  -- Today's preventive work falls due (as night audit would generate it).
  perform pg_temp.act(pg_temp.ref('staff:rajesh'));
  perform mt_generate_preventive(T, pg_temp.prop());
  perform pg_temp.act(pg_temp.admin());
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Events & banquets
-- ════════════════════════════════════════════════════════════════════════════
create function pg_temp.new_event(p_key text, p_space text, p_layout text, p_title text, p_type text, p_date date,
                                  p_start time, p_end time, p_pax int, p_guaranteed int, p_pkg text, p_basis text,
                                  p_company text, p_guest text, p_contact text, p_phone text, p_email text,
                                  p_created timestamptz, p_setup text, p_service text, p_av text, p_menu text)
returns uuid language plpgsql as $$
declare v uuid; v_fy text := financial_year_of(p_date); v_seq int;
begin
  v_seq := next_event_number(v_fy);
  insert into event_bookings (number, financial_year, seq, space_id, layout_id, title, event_type, guest_id, company_id,
                              contact_name, contact_phone, contact_email, payment_terms, event_date, start_time, end_time,
                              setup_from, teardown_to, pax_expected, pax_guaranteed, package_id, menu_notes, rental_basis,
                              beo_setup_notes, beo_service_notes, beo_av_notes, created_by, created_at, updated_at)
  values ('EVT/' || v_fy || '/' || lpad(v_seq::text, 4, '0'), v_fy, v_seq, pg_temp.ref('space:' || p_space),
          (select id from event_layouts where space_id = pg_temp.ref('space:' || p_space) and name = p_layout),
          p_title, p_type, case when p_guest is not null then pg_temp.ref('guest:' || p_guest) end,
          case when p_company is not null then pg_temp.ref('co:' || p_company) end,
          p_contact, p_phone, p_email, '25% advance to confirm, balance on the day', p_date, p_start, p_end,
          p_start - interval '2 hours', p_end + interval '1 hour', p_pax, p_guaranteed,
          (select id from event_packages where code = p_pkg and property_id = pg_temp.prop()), p_menu, p_basis,
          p_setup, p_service, p_av, pg_temp.ref('staff:farah'), p_created, p_created)
  returning id into v;
  perform pg_temp.setref('evt:' || p_key, v);
  return v;
end $$;

create function pg_temp.event_line(p_event uuid, p_kind text, p_desc text, p_qty numeric, p_price numeric, p_equipment text default null)
returns void language sql as $$
  insert into event_lines (event_id, kind, equipment_id, description, qty, unit_price, tax_rate, created_by)
  values (p_event, p_kind, (select id from event_equipment where name = p_equipment and property_id = pg_temp.prop()),
          p_desc, p_qty, coalesce(p_price, (select rental_price from event_equipment where name = p_equipment and property_id = pg_temp.prop())), 18,
          pg_temp.ref('staff:farah'))
$$;

do $$
declare
  T date := pg_temp.today(); e uuid; v_pay uuid; v_bal numeric; b record; v_lines jsonb; v_net numeric; v_tax numeric;
  p properties; v_fy text; v_seq int; v_co companies; v_space text; v_state text; v_inv uuid;
begin
  select * into p from properties where id = pg_temp.prop();

  -- 1. Completed conference, invoiced and paid.
  e := pg_temp.new_event('meridian', 'hall', 'Classroom', 'Meridian Pharma — West Zone Sales Meet', 'conference', T - 12,
         '09:30', '17:30', 80, 75, 'CONF-FD', 'full_day', 'meridian', null, 'Hetal Parikh', '+91 79 2658 1100',
         'admin@meridianpharma.example.in', (T - 40) + time '12:00',
         'Classroom for 80, head table for 4, registration desk at the foyer', 'Tea at 11:00 and 16:00, buffet lunch 13:00–14:00',
         'Projector, PA with two handheld mics, podium', 'Lunch: veg and non-veg, Jain option for 6');
  perform pg_temp.event_line(e, 'equipment', 'Projector and screen', 1, null, 'Projector and screen');
  perform pg_temp.event_line(e, 'equipment', 'Public address system', 1, null, 'Public address system');
  perform pg_temp.event_line(e, 'equipment', 'Additional microphone', 2, null, 'Additional microphone');
  perform pg_temp.act(pg_temp.ref('staff:farah'));
  perform event_submit_quote(e);
  perform pg_temp.act(pg_temp.ref('staff:rajesh'));
  if (select approval_required from event_bookings where id = e) then perform event_approve_quote(e); end if;
  perform pg_temp.act(pg_temp.ref('staff:farah'));
  perform event_confirm(e);
  v_pay := event_take_payment(e, 'advance', 'bank_transfer', round((select grand_total from event_bookings where id = e) * 0.25), 'NEFT-MER-2210', 'Advance against quotation');
  update event_payments set created_at = (T - 30) + time '15:00' where id = v_pay;
  perform event_complete(e, 82);
  update event_bookings set quoted_at = (T - 39) + time '16:00', approved_at = (T - 38) + time '11:00',
         confirmed_at = (T - 31) + time '10:30', contract_signed_on = T - 31, contract_signed_name = 'Hetal Parikh',
         completed_at = (T - 12) + time '18:30' where id = e;
  -- Its GST invoice (issueEventInvoice), the day after.
  select * into v_co from companies where id = pg_temp.ref('co:meridian');
  select name into v_space from event_spaces where id = pg_temp.ref('space:hall');
  v_state := coalesce(nullif(p.gst_state_code, ''), left(p.gstin, 2));
  select jsonb_agg(jsonb_build_object('date', (T - 12)::text,
           'description', 'Meridian Pharma — West Zone Sales Meet — ' || v_space || ' on ' || (T - 12)
                          || case when b2.rate <> 0 then ' (taxed at ' || trim_scale(b2.rate) || '%)' else '' end,
           'kind', 'event', 'net', b2.net, 'tax_rate', b2.rate, 'tax', b2.tax, 'total', round(b2.net + b2.tax, 2), 'dept', 'events',
           'sac', p.sac_event, 'cgst', round(b2.tax / 2, 2), 'sgst', round(b2.tax - round(b2.tax / 2, 2), 2), 'igst', 0) order by b2.rate),
         round(sum(b2.net), 2), round(sum(b2.tax), 2)
    into v_lines, v_net, v_tax from event_tax_bands(e) b2;
  v_fy := financial_year_of(T - 11);
  v_seq := next_invoice_number(coalesce(nullif(p.invoice_prefix, ''), 'INV'), v_fy);
  insert into invoices (number, series, financial_year, seq, event_id, bill_to_name, bill_to_address, bill_to_gstin, bill_to_state_code,
                        place_of_supply, tax_regime, supplier_gstin, supplier_state_code, is_interstate, currency,
                        net_total, tax_total, grand_total, cgst_total, sgst_total, igst_total, tax_breakdown, lines, issued_at, issued_by)
  select coalesce(nullif(p.invoice_prefix, ''), 'INV') || '/' || v_fy || '/' || lpad(v_seq::text, 4, '0'),
         coalesce(nullif(p.invoice_prefix, ''), 'INV'), v_fy, v_seq, e, v_co.name, v_co.billing_address, v_co.gstin, left(v_co.gstin, 2),
         v_state || ' – ' || (select name from pg_temp.gst_states where code = v_state), 'gst', p.gstin, v_state, false, p.currency,
         v_net, v_tax, round(v_net + v_tax, 2),
         (select sum((l->>'cgst')::numeric) from jsonb_array_elements(v_lines) l), (select sum((l->>'sgst')::numeric) from jsonb_array_elements(v_lines) l), 0,
         (select jsonb_agg(jsonb_build_object('rate', (l->>'tax_rate')::numeric, 'net', (l->>'net')::numeric, 'tax', (l->>'tax')::numeric,
                 'sac', l->>'sac', 'cgst', (l->>'cgst')::numeric, 'sgst', (l->>'sgst')::numeric, 'igst', 0)) from jsonb_array_elements(v_lines) l),
         v_lines, (T - 11) + time '11:00', pg_temp.ref('staff:nikhil')
  returning id into v_inv;
  perform pg_temp.act(pg_temp.ref('staff:nikhil'));
  v_bal := event_balance(e);
  v_pay := event_take_payment(e, 'payment', 'bank_transfer', v_bal, 'NEFT-MER-2291', 'Balance against invoice');
  update event_payments set created_at = (T - 5) + time '12:20' where id = v_pay;

  -- 2. Board meeting in two days, confirmed (below the approval threshold).
  e := pg_temp.new_event('northstar', 'lotus', 'Boardroom', 'Northstar Consulting — Quarterly Board Meeting', 'corporate_meeting', T + 2,
         '10:00', '16:00', 14, 14, 'LUNCH-V', 'full_day', 'northstar', null, 'Ritika Bhalla', '+91 11 4050 7788', 'ops@northstar.example.com',
         (T - 9) + time '11:30', 'Boardroom for 14, name cards, notepads', 'Working lunch served in the room at 13:00', 'VC screen and speakerphone', '');
  perform pg_temp.event_line(e, 'other', 'Video-conferencing setup', 1, 3500);
  perform pg_temp.act(pg_temp.ref('staff:farah'));
  perform event_submit_quote(e);
  perform event_confirm(e);
  update event_bookings set quoted_at = (T - 8) + time '10:00', confirmed_at = (T - 6) + time '17:00' where id = e;

  -- 3. Wedding reception on the lawn, confirmed with an advance.
  e := pg_temp.new_event('wedding', 'lawn', 'Banquet (round tables)', 'Kapoor–Bansal Wedding Reception', 'reception', T + 13,
         '19:00', '22:45', 300, 280, 'GALA', 'full_day', null, 'divya', 'Sunil Kapoor', '+91 98200 11223', 'sunil.kapoor@example.in',
         (T - 26) + time '17:00', 'Stage 24×12 ft, 30 round tables, bar counter near the gazebo',
         'Welcome drinks at 19:00, dinner buffet from 20:30, live counters (chaat, tandoor)', 'DJ by client; hotel provides PA and stage lighting',
         'North Indian gala menu with Jain counter; mocktail bar');
  perform pg_temp.event_line(e, 'decor', 'Floral mandap and stage décor', 1, 85000);
  perform pg_temp.event_line(e, 'equipment', 'Public address system', 1, null, 'Public address system');
  perform pg_temp.event_line(e, 'equipment', 'Stage riser', 6, null, 'Stage riser');
  perform pg_temp.event_line(e, 'food_extra', 'Live chaat counter', 280, 180);
  perform event_submit_quote(e);
  perform pg_temp.act(pg_temp.ref('staff:rajesh'));
  perform event_approve_quote(e);
  perform pg_temp.act(pg_temp.ref('staff:farah'));
  perform event_confirm(e);
  v_pay := event_take_payment(e, 'advance', 'card', round((select grand_total from event_bookings where id = e) * 0.25, -3), 'CARD-9917', '25% advance');
  update event_payments set created_at = (T - 20) + time '13:10' where id = v_pay;
  update event_bookings set quoted_at = (T - 24) + time '12:00', approved_at = (T - 23) + time '18:00', confirmed_at = (T - 20) + time '13:00',
         contract_signed_on = T - 20, contract_signed_name = 'Sunil Kapoor', booking_id = null where id = e;

  -- 4. Leadership summit quoted, waiting for the GM's approval.
  e := pg_temp.new_event('zenith', 'hall', 'Theatre', 'Zenith Infotech — Annual Leadership Summit', 'residential_conference', T + 20,
         '09:00', '18:00', 140, 120, 'CONF-FD', 'full_day', 'zenith', null, 'Lakshmi Narayan', '+91 80 4123 5500', 'travel.desk@zenith.example.com',
         (T - 4) + time '10:00', 'Theatre for 140 with stage and two screens', 'Tea breaks 11:00 and 15:30, lunch 13:00', 'Two projectors, 4 mics, podium, stage backdrop', '');
  perform pg_temp.event_line(e, 'equipment', 'Projector and screen', 1, null, 'Projector and screen');
  perform pg_temp.event_line(e, 'equipment', 'Additional microphone', 4, null, 'Additional microphone');
  perform pg_temp.event_line(e, 'equipment', 'Stage backdrop', 1, null, 'Stage backdrop');
  perform event_submit_quote(e);
  update event_bookings set quoted_at = (T - 3) + time '15:30' where id = e;

  -- 5. A birthday enquiry, not yet priced.
  e := pg_temp.new_event('birthday', 'hall', 'Banquet (round tables)', 'Aarav''s First Birthday', 'birthday', T + 33,
         '12:30', '16:00', 60, 0, 'HI-TEA', 'half_day', null, 'tanvi', 'Tanvi Joshi', (select phone from guests where id = pg_temp.ref('guest:tanvi')),
         (select email from guests where id = pg_temp.ref('guest:tanvi')), (T - 1) + time '18:45', '', '', '', 'Kids'' menu; eggless cake from outside allowed?');
  perform pg_temp.act(pg_temp.admin());
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Revenue: pricing rules, approvals, competitor rates
-- ════════════════════════════════════════════════════════════════════════════
do $$
declare T date := pg_temp.today(); v_rule uuid; v_rule2 uuid; c record; d date; rt text; v_base numeric;
begin
  insert into pricing_rules (name, description, room_type_id, min_occupancy, max_occupancy, days_of_week, adjustment_kind, adjustment_value, floor_rate, ceiling_rate, priority, min_lead_days, max_lead_days, occasion, start_date, end_date)
  values ('High demand', 'Over 80% forecast occupancy: +10%', null, 80, null, '{0,1,2,3,4,5,6}', 'percent', 10, 0, 22000, 2, null, null, '', null, null)
  returning id into v_rule;
  insert into pricing_rules (name, description, room_type_id, min_occupancy, max_occupancy, days_of_week, adjustment_kind, adjustment_value, floor_rate, ceiling_rate, priority, min_lead_days, max_lead_days, occasion, start_date, end_date)
  values ('Last-minute fill', 'Under 40% occupancy within two days of arrival: −10%', null, null, 40, '{0,1,2,3,4,5,6}', 'percent', -10, 4500, 0, 1, 0, 2, '', null, null)
  returning id into v_rule2;
  insert into pricing_rules (name, description, room_type_id, min_occupancy, days_of_week, adjustment_kind, adjustment_value, priority, occasion, start_date, end_date, is_active) values
   ('Weekend premium', 'Fri–Sat over 60%: +8%', null, 60, '{5,6}', 'percent', 8, 1, '', null, null, true),
   ('Wedding season', 'Peak wedding dates', null, null, '{0,1,2,3,4,5,6}', 'percent', 12, 3, 'Wedding season', T + 10, T + 75, true),
   ('Suite floor rate', 'Never below ₹14,000', pg_temp.ref('rt:suite'), null, '{0,1,2,3,4,5,6}', 'amount', 0, 0, '', null, null, false);

  foreach rt in array array['rt:a', 'rt:b'] loop
    v_base := (select base_rate from room_types where id = pg_temp.ref(rt));
    insert into pricing_adjustments (stay_date, room_type_id, rule_id, rule_name, base_rate, proposed_rate, change_percent, occupancy_percent,
                                     rooms_sold, capacity, status, threshold_percent, note, created_at, decided_at, decided_by)
    values
     (T + 12, pg_temp.ref(rt), v_rule, 'High demand', v_base, round(v_base * 1.22), 22, 86, case when rt = 'rt:a' then 9 else 7 end,
      case when rt = 'rt:a' then 10 else 8 end, 'pending', 10, 'Wedding group in house; +22% is above the 10% auto-approve limit',
      now() - interval '6 hours', null, null),
     (T + 13, pg_temp.ref(rt), v_rule, 'High demand', v_base, round(v_base * 1.18), 18, 82, case when rt = 'rt:a' then 9 else 6 end,
      case when rt = 'rt:a' then 10 else 8 end, 'pending', 10, '', now() - interval '6 hours', null, null),
     (T + 1, pg_temp.ref(rt), v_rule2, 'Last-minute fill', v_base, round(v_base * 0.9), -10, 35, 3, case when rt = 'rt:a' then 10 else 8 end,
      'rejected', 10, 'GM: hold the rate, corporate pickup expected', now() - interval '30 hours', now() - interval '20 hours', pg_temp.ref('staff:rajesh')),
     (T - 2, pg_temp.ref(rt), v_rule2, 'Last-minute fill', v_base, round(v_base * 0.9), -10, 38, 3, case when rt = 'rt:a' then 10 else 8 end,
      'expired', 10, '', now() - interval '4 days', null, null);
  end loop;

  insert into competitor_properties (name, source, notes, sort_order) values
   ('The Grand Orchid', 'MakeMyTrip', 'Five-star across the lake', 1),
   ('Lakeview Residency', 'Booking.com', 'Closest like-for-like', 2),
   ('Hotel Sapphire Inn', 'Agoda', 'Budget business hotel', 3),
   ('Royal Heritage Suites', 'Brand website', 'Boutique, strong on weddings', 4);
  for c in select id, sort_order from competitor_properties where property_id = pg_temp.prop()
             and id::text not in (select id from demo_seed.pre where tbl = 'competitor_properties') loop
    for d in select generate_series(T, T + 13, interval '1 day')::date loop
      foreach rt in array array['rt:a', 'rt:b'] loop
        v_base := (select base_rate from room_types where id = pg_temp.ref(rt));
        insert into competitor_rates (competitor_id, stay_date, room_type_id, rate, meal_plan, tax_inclusive, sold_out, observed_at, observed_by)
        values (c.id, d, pg_temp.ref(rt),
                round(v_base * case c.sort_order when 1 then 1.35 when 2 then 1.02 when 3 then 0.72 else 1.15 end
                      * case when extract(dow from d) in (5, 6) then 1.1 else 1 end * (0.95 + random() * 0.1)::numeric, -1),
                case when c.sort_order = 3 then 'EP' else 'CP' end, c.sort_order <> 3,
                c.sort_order = 4 and d between T + 12 and T + 13, now() - interval '3 hours', pg_temp.ref('staff:meera'));
      end loop;
    end loop;
  end loop;
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Reports and notifications
-- ════════════════════════════════════════════════════════════════════════════
insert into report_schedules (name, report, frequency, recipients, is_active, last_sent_at, last_status, created_by, created_at) values
 ('Daily revenue to the GM', 'daily_revenue', 'daily', 'rajesh.iyer@example.com, owner@example.in', true,
  (pg_temp.today()) + time '07:00', 'sent', pg_temp.ref('staff:nikhil'), now() - interval '45 days'),
 ('Weekly KPI summary', 'kpi_summary', 'weekly', 'rajesh.iyer@example.com, nikhil.agarwal@example.com', true,
  date_trunc('week', now()) + interval '7 hours', 'sent', pg_temp.ref('staff:nikhil'), now() - interval '45 days'),
 ('Outstanding balances (month end)', 'outstanding', 'monthly', 'nikhil.agarwal@example.com', true, null, '', pg_temp.ref('staff:nikhil'), now() - interval '10 days'),
 ('Maintenance backlog', 'maintenance', 'weekly', 'suresh.patil@example.com', false, null, '', pg_temp.ref('staff:rajesh'), now() - interval '30 days');

do $$
declare r record; k int := 0;
begin
  for r in select b.id, b.guest_id, b.contact_email, b.contact_phone, b.contact_name, b.reference, b.created_at, b.check_in, b.status
             from bookings b where b.id in (select id from pg_temp.bk) and b.contact_email is not null
            order by b.created_at desc limit 40 loop
    k := k + 1;
    insert into notifications (booking_id, guest_id, channel, template, recipient, subject, body, status, provider_id, error, created_by, created_at, kind)
    values (r.id, r.guest_id, 'email', 'confirmation', r.contact_email, 'Your booking ' || r.reference || ' is confirmed',
            'Dear ' || r.contact_name || ', thank you for choosing us. We look forward to welcoming you on ' || to_char(r.check_in, 'DD Mon YYYY') || '.',
            case when k % 13 = 0 then 'failed' else 'sent' end, case when k % 13 = 0 then '' else 'msg_' || substr(md5(r.id::text), 1, 16) end,
            case when k % 13 = 0 then 'Mailbox unavailable (550)' else '' end, null, r.created_at + interval '2 minutes', 'guest');
    if k % 3 = 0 then
      insert into notifications (booking_id, guest_id, channel, template, recipient, subject, body, status, error, created_at, kind)
      values (r.id, r.guest_id, 'sms', 'confirmation', coalesce(r.contact_phone, ''), '', 'Booking ' || r.reference || ' confirmed.', 'skipped',
              'No SMS provider configured', r.created_at + interval '2 minutes', 'guest');
    end if;
  end loop;
  insert into notifications (booking_id, guest_id, channel, template, recipient, subject, body, status, provider_id, created_at, kind)
  select b.id, b.guest_id, 'email', 'post_stay', b.contact_email, 'How was your stay?', 'Tell us about your stay — it takes a minute.',
         'sent', 'msg_' || substr(md5(b.id::text || 'ps'), 1, 16), b.checked_out_at + interval '1 day', 'guest'
    from bookings b where b.id in (select id from pg_temp.bk) and b.status = 'checked_out' and b.contact_email is not null
     and b.checked_out_at < now() - interval '1 day'
   order by b.checked_out_at desc limit 12;
  insert into notifications (booking_id, guest_id, channel, template, recipient, subject, body, status, provider_id, created_at, kind)
  select b.id, b.guest_id, 'email', 'pre_arrival', b.contact_email, 'See you soon', 'Your room is almost ready. Reply with your arrival time.',
         'sent', 'msg_' || substr(md5(b.id::text || 'pa'), 1, 16), (b.check_in - 3) + time '10:00', 'guest'
    from bookings b where b.id in (select id from pg_temp.bk) and b.status in ('confirmed', 'checked_in')
     and b.check_in between pg_temp.today() and pg_temp.today() + 3 and b.contact_email is not null and (b.check_in - 3) + time '10:00' < now();
  insert into notifications (ticket_id, staff_id, channel, template, recipient, subject, body, status, provider_id, created_at, kind)
  select t.id, t.assigned_to, 'email', 'ticket_assigned', s.email, 'Ticket ' || t.reference || ' assigned to you', t.title, 'sent',
         'msg_' || substr(md5(t.id::text), 1, 16), coalesce(t.assigned_at, t.created_at), 'staff'
    from maintenance_tickets t join staff s on s.id = t.assigned_to
   where t.property_id = pg_temp.prop() and t.assigned_to is not null;
  insert into notifications (booking_id, staff_id, channel, template, recipient, subject, body, status, provider_id, created_at, kind)
  select pg_temp.ref('bk:arr-vip'), id, 'email', 'vip_arrival', email, 'VIP arriving today: Aarav Mehta', 'Suite 402, ETA 16:00. Anniversary amenities requested.',
         'sent', 'msg_' || substr(md5(id::text || 'vip'), 1, 16), pg_temp.ts(pg_temp.today(), '07:00'), 'staff'
    from staff where id in (pg_temp.ref('staff:priya'), pg_temp.ref('staff:rajesh'));
end $$;

-- ════════════════════════════════════════════════════════════════════════════
-- Finish: live stock links, business date, audit trail dates, registry
-- ════════════════════════════════════════════════════════════════════════════
-- From now on outlet sales and room cleans take stock out automatically.
update inventory_items ii set pos_item_id = m.pos_item from pg_temp.inv_pos m where ii.id = m.inv_item;
update inventory_items ii set hk_checklist_item_id = h.id
  from pg_temp.inv i join hk_checklist_items h on h.label = i.hk and h.property_id = pg_temp.prop()
 where ii.id = pg_temp.ref('inv:' || i.sku) and i.hk is not null;

-- Yesterday was the last day closed; today is the business date.
update properties set business_date = pg_temp.today()
 where id = pg_temp.prop() and business_date < pg_temp.today();

-- The audit trail: each insert dated when the row says it happened.
update audit_log a set occurred_at = (a.after ->> 'created_at')::timestamptz
 where a.id > pg_temp.info('audit_max')::bigint and a.action = 'insert' and a.after ? 'created_at'
   and (a.after ->> 'created_at')::timestamptz < a.occurred_at;

-- What this script added, for remove_demo.sql.
do $$
declare t text;
begin
  for t in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables tt on tt.table_schema = c.table_schema and tt.table_name = c.table_name
     where c.table_schema = 'public' and c.column_name = 'id' and tt.table_type = 'BASE TABLE'
       and c.table_name not in ('audit_log', 'login_attempts', 'job_runs')
  loop
    execute format('insert into demo_seed.rows select %L, id::text from public.%I x
                     where not exists (select 1 from demo_seed.pre p where p.tbl = %L and p.id = x.id::text)', t, t, t);
  end loop;
  insert into demo_seed.rows select 'auth.users', id::text from auth.users x
   where not exists (select 1 from demo_seed.pre p where p.tbl = 'auth.users' and p.id = x.id::text);
  insert into demo_seed.rows select 'night_audits', business_date::text from night_audits
   where property_id = pg_temp.prop() and started_by = pg_temp.ref('staff:vikram');
  insert into demo_seed.info values ('audit_end', (select max(id) from audit_log)::text), ('finished_at', clock_timestamp()::text);
end $$;

\echo 'BluInn demo data loaded. Summary:'
select tbl as "table", count(*) as rows_added from demo_seed.rows group by tbl order by count(*) desc, tbl;

commit;
