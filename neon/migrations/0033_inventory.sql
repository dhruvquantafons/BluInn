-- ============================================================================
-- Front Office & Operations build-out, part 7: inventory and stores (v1)
--
-- What a hotel keeps on its shelves — guest amenities, linen, minibar stock,
-- cleaning supplies, engineering spares — where it is, and every movement.
--
--   • inventory_locations: the main store, floor pantries, an outlet's bar.
--   • inventory_items: what is stocked, its unit, par and re-order levels, and
--     optionally the POS item or housekeeping checklist line it is.
--   • inventory_movements: one signed row per location touched. Receiving
--     adds; issuing, consuming and wastage take away; a transfer is two rows
--     sharing a transfer_id; a count adjusts. Rows are never edited.
--   • stock_levels: the balance per item and location.
--
-- Stock moves on its own when:
--   • an outlet bill is settled — each line whose POS item is linked is taken
--     from the location attached to that outlet (minibar, bar);
--   • a housekeeping task is cleaned — each ticked checklist line linked to
--     an item is taken from the property's housekeeping location.
--
-- Permissions: inventory.view (see stock), inventory.manage (move it, set up).
--
-- Run after 0032_operations.sql.
-- ============================================================================

create table if not exists inventory_locations (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null default current_property() references properties on delete restrict,
  name        text not null check (length(trim(name)) > 0),
  kind        text not null default 'store' check (kind in ('store', 'floor', 'outlet', 'other')),
  -- Stock an outlet sells from (its bills consume from here).
  outlet_id   uuid references pos_outlets on delete set null,
  -- Where housekeeping's checklist consumption is taken from.
  hk_default  boolean not null default false,
  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now()
);

create unique index if not exists inventory_locations_name_idx on inventory_locations (property_id, lower(name));
create unique index if not exists inventory_locations_outlet_idx on inventory_locations (outlet_id) where outlet_id is not null;
create unique index if not exists inventory_locations_hk_idx on inventory_locations (property_id) where hk_default;

create table if not exists inventory_items (
  id               uuid primary key default gen_random_uuid(),
  property_id      uuid not null default current_property() references properties on delete restrict,
  sku              text not null default '',
  name             text not null check (length(trim(name)) > 0),
  category         text not null default 'other'
                   check (category in ('amenity', 'linen', 'minibar', 'cleaning', 'engineering', 'food', 'beverage', 'other')),
  unit             text not null default 'each' check (length(trim(unit)) > 0),
  par_level        numeric(12,3) not null default 0 check (par_level >= 0),
  reorder_level    numeric(12,3) not null default 0 check (reorder_level >= 0),
  unit_cost        numeric(12,2) not null default 0 check (unit_cost >= 0),
  pos_item_id      uuid references pos_items on delete set null,
  hk_checklist_item_id uuid references hk_checklist_items on delete set null,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create unique index if not exists inventory_items_sku_idx on inventory_items (property_id, lower(sku)) where sku <> '';
create unique index if not exists inventory_items_pos_idx on inventory_items (pos_item_id) where pos_item_id is not null;
create unique index if not exists inventory_items_hk_idx on inventory_items (hk_checklist_item_id) where hk_checklist_item_id is not null;

create table if not exists inventory_movements (
  id          uuid primary key default gen_random_uuid(),
  property_id uuid not null default current_property() references properties on delete restrict,
  item_id     uuid not null references inventory_items on delete restrict,
  location_id uuid not null references inventory_locations on delete restrict,
  kind        text not null check (kind in ('receive', 'issue', 'transfer', 'consume', 'adjust', 'wastage')),
  -- Signed: + into this location, − out of it.
  qty         numeric(12,3) not null check (qty <> 0),
  unit_cost   numeric(12,2) not null default 0 check (unit_cost >= 0),
  reason      text not null default '',
  -- What caused it: a POS bill number, a housekeeping task, a supplier invoice.
  reference   text not null default '',
  transfer_id uuid,
  created_by  uuid references staff on delete set null,
  created_at  timestamptz not null default now(),
  constraint inventory_movement_sign check (
    (kind = 'receive' and qty > 0)
    or (kind in ('consume', 'wastage', 'issue') and qty < 0)
    or kind in ('transfer', 'adjust')
  )
);

create index if not exists inventory_movements_item_idx on inventory_movements (item_id, location_id);
create index if not exists inventory_movements_recent_idx on inventory_movements (property_id, created_at desc);

-- Movements are a ledger: never edited, never deleted.
create or replace function inventory_movement_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'INVENTORY_IMMUTABLE: stock movements are never changed; record an adjustment instead';
end;
$$;

drop trigger if exists inventory_movements_immutable on inventory_movements;
create trigger inventory_movements_immutable before update or delete on inventory_movements
  for each row execute function inventory_movement_immutable();

create or replace view stock_levels with (security_invoker = true) as
  select m.item_id, m.location_id, m.property_id, sum(m.qty) as qty, max(m.created_at) as last_moved_at
    from inventory_movements m
   group by m.item_id, m.location_id, m.property_id;

-- ── Moving stock ────────────────────────────────────────────────────────────

/*
 * One stock movement, from the screens. p_qty is always positive; the kind
 * says which way it goes:
 *   receive   into p_to (from a supplier)
 *   issue     out of p_from into p_to (store → floor pantry), or out to use
 *   transfer  same as issue with both ends
 *   consume   out of p_from
 *   wastage   out of p_from (broken, expired)
 *   adjust    a stock count: p_qty is what was counted at p_to
 */
create or replace function inventory_move(
  p_item uuid, p_kind text, p_qty numeric,
  p_from uuid default null, p_to uuid default null,
  p_reason text default '', p_unit_cost numeric default null, p_reference text default ''
) returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_item     inventory_items;
  v_transfer uuid := gen_random_uuid();
  v_current  numeric;
  v_cost     numeric := p_unit_cost;
begin
  if not has_permission('inventory.manage') then
    raise exception 'not permitted';
  end if;
  select * into v_item from inventory_items where id = p_item and property_id = current_property();
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

-- ── Consumption that happens on its own ─────────────────────────────────────

/* An outlet bill settled: its linked items leave the outlet's location. */
create or replace function inventory_consume_pos()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_location uuid;
begin
  if new.status <> 'settled' or old.status = 'settled' then return new; end if;
  select id into v_location from inventory_locations where outlet_id = new.outlet_id and is_active;
  if v_location is null then return new; end if;

  insert into inventory_movements (property_id, item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
  select new.property_id, ii.id, v_location, 'consume', -sum(l.qty), ii.unit_cost, 'Sold', new.number, auth.uid()
    from pos_order_lines l
    join inventory_items ii on ii.pos_item_id = l.item_id and ii.is_active
   where l.order_id = new.id and l.voided_at is null
   group by ii.id, ii.unit_cost
  having sum(l.qty) > 0;
  return new;
end;
$$;

drop trigger if exists pos_orders_inventory on pos_orders;
create trigger pos_orders_inventory after update of status on pos_orders
  for each row execute function inventory_consume_pos();

/* A room cleaned: the ticked checklist lines linked to items are used up. */
create or replace function inventory_consume_hk()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_location uuid;
  v_room     text;
begin
  if new.status <> 'cleaned' or old.status = 'cleaned' then return new; end if;
  select id into v_location from inventory_locations
   where property_id = new.property_id and hk_default and is_active;
  if v_location is null then return new; end if;
  select room_number into v_room from rooms where id = new.room_id;

  insert into inventory_movements (property_id, item_id, location_id, kind, qty, unit_cost, reason, reference, created_by)
  select new.property_id, ii.id, v_location, 'consume', -sum((e ->> 'qty')::numeric), ii.unit_cost,
         'Room ' || coalesce(v_room, ''), 'HK ' || left(new.id::text, 8), auth.uid()
    from jsonb_array_elements(coalesce(new.checklist, '[]'::jsonb)) e
    join inventory_items ii on ii.hk_checklist_item_id = (e ->> 'item_id')::uuid and ii.is_active
   where coalesce((e ->> 'done')::boolean, false)
     and coalesce((e ->> 'qty')::numeric, 0) > 0
   group by ii.id, ii.unit_cost;
  return new;
end;
$$;

drop trigger if exists housekeeping_tasks_inventory on housekeeping_tasks;
create trigger housekeeping_tasks_inventory after update of status on housekeeping_tasks
  for each row execute function inventory_consume_hk();

-- ── Row level security ──────────────────────────────────────────────────────

alter table inventory_locations enable row level security;
alter table inventory_items     enable row level security;
alter table inventory_movements enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['inventory_locations', 'inventory_items'] loop
    execute format('drop policy if exists %I on %I', t || '_select', t);
    execute format('drop policy if exists %I on %I', t || '_write', t);
    execute format('drop policy if exists %I on %I', t || '_property', t);
    execute format('create policy %I on %I for select using (has_permission(''inventory.view'') or has_permission(''inventory.manage''))',
                   t || '_select', t);
    execute format('create policy %I on %I for all using (has_permission(''inventory.manage'')) with check (has_permission(''inventory.manage''))',
                   t || '_write', t);
    execute format('create policy %I on %I as restrictive for all using (can_access_property(property_id)) with check (can_access_property(property_id))',
                   t || '_property', t);
  end loop;
end;
$$;

-- Movements are written only by inventory_move() and the triggers above.
drop policy if exists inventory_movements_select   on inventory_movements;
drop policy if exists inventory_movements_property on inventory_movements;
create policy inventory_movements_select on inventory_movements for select
  using (has_permission('inventory.view') or has_permission('inventory.manage'));
create policy inventory_movements_property on inventory_movements as restrictive for all
  using (can_access_property(property_id)) with check (can_access_property(property_id));

do $$
declare
  t text;
begin
  foreach t in array array['inventory_locations', 'inventory_items'] loop
    execute format('drop trigger if exists %I on %I', t || '_audit', t);
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function audit_row(%L)',
      t || '_audit', t, 'inventory');
  end loop;
end;
$$;

-- ── Permissions ─────────────────────────────────────────────────────────────

insert into role_permissions (role_key, permission)
select r, p from (values
  ('manager', 'inventory.view'), ('manager', 'inventory.manage'),
  ('housekeeping_supervisor', 'inventory.view'), ('housekeeping_supervisor', 'inventory.manage'),
  ('maintenance_supervisor', 'inventory.view'), ('maintenance_supervisor', 'inventory.manage'),
  ('fb_manager', 'inventory.view'), ('fb_manager', 'inventory.manage'),
  ('finance', 'inventory.view'),
  ('front_office_manager', 'inventory.view')
) as seed (r, p)
where exists (select 1 from roles where key = seed.r)
on conflict do nothing;
