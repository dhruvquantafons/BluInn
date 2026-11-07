-- ============================================================================
-- Removes the BluInn demo data loaded by neon/demo/seed_demo.sql.
--
--   psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f neon/demo/remove_demo.sql
--
-- One transaction. It deletes exactly the rows the seed recorded in
-- demo_seed.rows (and the link rows that hang off them), puts back the few
-- existing rows the seed changed, then drops the demo_seed schema. Rows that
-- were there before the seed — the administrator, the property, the seeded
-- masters, any real booking or guest — are never touched.
--
-- Folio lines, invoices, credit notes and stock movements are append-only by
-- trigger (FOLIO_IMMUTABLE, INVOICE_IMMUTABLE, ...), as the law wants for real
-- books. To take demo books away the user triggers on the affected tables are
-- disabled for this transaction only (ALTER TABLE ... DISABLE TRIGGER USER,
-- which needs the table owner — the role that ran the migrations; on Neon,
-- the database owner) and re-enabled before commit. Foreign-key checks stay on.
--
-- If someone has since attached real data to a demo row (say, a new booking
-- in a demo room), the delete stops and nothing is removed; the message says
-- which table still holds demo rows.
--
-- Not reversed: sequence values (booking, group, ticket, lost-and-found and
-- loyalty member numbers carry on from where the demo left them), and the
-- property's business date (left at the day the demo ended on).
-- ============================================================================
\set ON_ERROR_STOP on
\set QUIET on
set client_min_messages = warning;
begin;

do $$
begin
  if to_regnamespace('demo_seed') is null then
    raise exception 'DEMO_NOT_LOADED: there is no demo data to remove (schema demo_seed does not exist).';
  end if;
end $$;

-- ── Lift the append-only guards (and the audit/side-effect triggers) ────────
do $$
declare t text;
begin
  for t in select distinct tbl from demo_seed.rows where tbl not like 'auth.%'
           union select unnest(array['booking_guests', 'guest_identities', 'pos_item_modifiers', 'staff_properties',
                                     'night_audits', 'invoice_series', 'pos_order_series', 'event_series',
                                     'properties', 'pos_outlets', 'event_spaces', 'event_packages', 'event_equipment'])
  loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('alter table public.%I disable trigger user', t);
    end if;
  end loop;
end $$;

-- ── Link rows without an id of their own ────────────────────────────────────
delete from booking_guests
 where booking_id::text in (select id from demo_seed.rows where tbl = 'bookings')
    or guest_id::text in (select id from demo_seed.rows where tbl = 'guests');
delete from guest_identities where guest_id::text in (select id from demo_seed.rows where tbl = 'guests');
delete from pos_item_modifiers
 where item_id::text in (select id from demo_seed.rows where tbl = 'pos_items')
    or modifier_id::text in (select id from demo_seed.rows where tbl = 'pos_modifiers');
delete from staff_properties where staff_id::text in (select id from demo_seed.rows where tbl = 'staff');
delete from night_audits
 where property_id = (select val::uuid from demo_seed.info where key = 'property')
   and business_date::text in (select id from demo_seed.rows where tbl = 'night_audits');

-- ── Every recorded row, children before parents ─────────────────────────────
-- Deleting a table's demo rows fails while another table still points at
-- them, so keep going round until a pass removes nothing more.
do $$
declare
  t text; n bigint; v_progress boolean; v_left text; v_pass int := 0; v_err text;
begin
  create temp table pending_tables on commit drop as
    select distinct tbl from demo_seed.rows where tbl <> 'night_audits';
  loop
    v_pass := v_pass + 1;
    v_progress := false;
    for t in select tbl from pending_tables order by tbl loop
      begin
        if t = 'auth.users' then
          delete from auth.users where id::text in (select id from demo_seed.rows where tbl = 'auth.users');
        else
          execute format('delete from public.%I where id::text in (select id from demo_seed.rows where tbl = %L)', t, t);
        end if;
        get diagnostics n = row_count;
        delete from pending_tables where tbl = t;
        v_progress := true;
      exception when foreign_key_violation or restrict_violation then
        v_err := sqlerrm;   -- still referenced; try again on the next pass
      end;
    end loop;
    exit when not exists (select 1 from pending_tables);
    if not v_progress then
      select string_agg(tbl, ', ') into v_left from pending_tables;
      raise exception 'DEMO_STILL_REFERENCED: demo rows in % are referenced by data added after the demo (%). Nothing was removed.',
        v_left, v_err;
    end if;
  end loop;
end $$;

-- ── Put back what the seed changed on existing rows ─────────────────────────
do $$
declare
  b jsonb := (select val::jsonb from demo_seed.info where key = 'property_before');
  x jsonb; s jsonb;
begin
  update properties set
    legal_name = b->>'legal_name', address = b->>'address', city = b->>'city', state = b->>'state',
    postcode = b->>'postcode', phone = b->>'phone', email = b->>'email',
    gst_state_code = b->>'gst_state_code', gstin = b->>'gstin',
    loyalty_enabled = (b->>'loyalty_enabled')::boolean,
    hr_geofence_lat = (b->>'hr_geofence_lat')::numeric, hr_geofence_lng = (b->>'hr_geofence_lng')::numeric,
    updated_at = (b->>'updated_at')::timestamptz
  where id = (b->>'id')::uuid;

  for x in select * from jsonb_array_elements(coalesce((select val::jsonb from demo_seed.info where key = 'outlets_before'), '[]')) loop
    update pos_outlets set is_active = (x->>'is_active')::boolean where id = (x->>'id')::uuid;
  end loop;

  s := (select val::jsonb from demo_seed.info where key = 'event_prices_before');
  for x in select * from jsonb_array_elements(coalesce(s->'spaces', '[]')) loop
    update event_spaces set rental_full_day = (x->>'rental_full_day')::numeric, rental_half_day = (x->>'rental_half_day')::numeric,
           rental_per_hour = (x->>'rental_per_hour')::numeric, min_charge = (x->>'min_charge')::numeric,
           floor = (x->>'floor')::int, area_sqft = (x->>'area_sqft')::int
     where id = (x->>'id')::uuid;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(s->'packages', '[]')) loop
    update event_packages set price_per_head = (x->>'price_per_head')::numeric, min_pax = (x->>'min_pax')::int where id = (x->>'id')::uuid;
  end loop;
  for x in select * from jsonb_array_elements(coalesce(s->'equipment', '[]')) loop
    update event_equipment set rental_price = (x->>'rental_price')::numeric where id = (x->>'id')::uuid;
  end loop;

  -- Number series: back to where they were, unless real documents have been
  -- numbered since (then to the highest number still in use).
  delete from invoice_series s2
   where not exists (select 1 from jsonb_array_elements((select val::jsonb from demo_seed.info where key = 'series_before')) o
                      where (o->>'property_id')::uuid = s2.property_id and o->>'series' = s2.series and o->>'financial_year' = s2.financial_year)
     and not exists (select 1 from invoices i where i.property_id = s2.property_id and i.series = s2.series and i.financial_year = s2.financial_year)
     and not exists (select 1 from credit_notes c where c.property_id = s2.property_id and c.series = s2.series and c.financial_year = s2.financial_year);
  update invoice_series s2 set last_seq = greatest(
           coalesce((select (o->>'last_seq')::int from jsonb_array_elements((select val::jsonb from demo_seed.info where key = 'series_before')) o
                      where (o->>'property_id')::uuid = s2.property_id and o->>'series' = s2.series and o->>'financial_year' = s2.financial_year), 0),
           coalesce((select max(seq) from invoices i where i.property_id = s2.property_id and i.series = s2.series and i.financial_year = s2.financial_year), 0),
           coalesce((select max(seq) from credit_notes c where c.property_id = s2.property_id and c.series = s2.series and c.financial_year = s2.financial_year), 0));

  delete from event_series s2
   where not exists (select 1 from jsonb_array_elements((select val::jsonb from demo_seed.info where key = 'event_series_before')) o
                      where (o->>'property_id')::uuid = s2.property_id and o->>'financial_year' = s2.financial_year)
     and not exists (select 1 from event_bookings e where e.property_id = s2.property_id and e.financial_year = s2.financial_year);
  update event_series s2 set last_seq = greatest(
           coalesce((select (o->>'last_seq')::int from jsonb_array_elements((select val::jsonb from demo_seed.info where key = 'event_series_before')) o
                      where (o->>'property_id')::uuid = s2.property_id and o->>'financial_year' = s2.financial_year), 0),
           coalesce((select max(seq) from event_bookings e where e.property_id = s2.property_id and e.financial_year = s2.financial_year), 0));

  delete from pos_order_series s2 where not exists (select 1 from pos_outlets o where o.id = s2.outlet_id)
     or (not exists (select 1 from jsonb_array_elements((select val::jsonb from demo_seed.info where key = 'pos_series_before')) o
                      where (o->>'outlet_id')::uuid = s2.outlet_id)
         and not exists (select 1 from pos_orders p where p.outlet_id = s2.outlet_id));
  update pos_order_series s2 set last_seq = coalesce((select (o->>'last_seq')::int from jsonb_array_elements((select val::jsonb from demo_seed.info where key = 'pos_series_before')) o
                      where (o->>'outlet_id')::uuid = s2.outlet_id), 0)
   where not exists (select 1 from pos_orders p where p.outlet_id = s2.outlet_id);
end $$;

-- ── The demo's audit trail ──────────────────────────────────────────────────
delete from audit_log
 where (id > (select val::bigint from demo_seed.info where key = 'audit_max')
        and id <= (select val::bigint from demo_seed.info where key = 'audit_end'))
    or (table_name, record_id) in (select tbl, id from demo_seed.rows);

-- ── Guards back on ──────────────────────────────────────────────────────────
do $$
declare t text;
begin
  for t in select distinct tbl from demo_seed.rows where tbl not like 'auth.%'
           union select unnest(array['booking_guests', 'guest_identities', 'pos_item_modifiers', 'staff_properties',
                                     'night_audits', 'invoice_series', 'pos_order_series', 'event_series',
                                     'properties', 'pos_outlets', 'event_spaces', 'event_packages', 'event_equipment'])
  loop
    if to_regclass('public.' || quote_ident(t)) is not null then
      execute format('alter table public.%I enable trigger user', t);
    end if;
  end loop;
end $$;

drop schema demo_seed cascade;
\echo 'BluInn demo data removed.'
commit;
