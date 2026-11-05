-- ============================================================================
-- Front Office & Operations build-out, part 4: who is in the room
--
--   1. booking_guests: everyone staying in the room, not only the person who
--      booked. Each sharer is a guest profile with their own identity record,
--      so every adult's ID is on file (registration_cards.accompanying stays
--      as free text for older stays). The booker is recorded as the primary
--      guest, by trigger, on every booking that has one.
--   2. guests.gender, which most police registers and registration cards ask
--      for.
--
-- Run after 0029_cashier_shifts.sql.
-- ============================================================================

alter table guests add column if not exists gender text not null default ''
  check (gender in ('', 'female', 'male', 'other'));

-- ── Everyone in the room ────────────────────────────────────────────────────

create table if not exists booking_guests (
  booking_id  uuid not null references bookings on delete restrict,
  guest_id    uuid not null references guests on delete restrict,
  property_id uuid not null default current_property() references properties on delete restrict,
  is_primary  boolean not null default false,
  added_by    uuid references staff on delete set null,
  added_at    timestamptz not null default now(),
  primary key (booking_id, guest_id)
);

create unique index if not exists booking_guests_one_primary_idx on booking_guests (booking_id) where is_primary;
create index if not exists booking_guests_guest_idx on booking_guests (guest_id);

-- The booker is the primary guest of every stay that has one.
insert into booking_guests (booking_id, guest_id, property_id, is_primary)
select b.id, b.guest_id, b.property_id, true
  from bookings b
 where b.guest_id is not null
on conflict do nothing;

-- ...and stays so: a booking that gains (or changes) its guest records them.
create or replace function booking_primary_guest()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.guest_id is not null and (tg_op = 'INSERT' or new.guest_id is distinct from old.guest_id) then
    update booking_guests set is_primary = false where booking_id = new.id and is_primary and guest_id <> new.guest_id;
    insert into booking_guests (booking_id, guest_id, property_id, is_primary)
    values (new.id, new.guest_id, new.property_id, true)
    on conflict (booking_id, guest_id) do update set is_primary = true;
  end if;
  return new;
end;
$$;

drop trigger if exists bookings_primary_guest on bookings;
create trigger bookings_primary_guest after insert or update of guest_id on bookings
  for each row execute function booking_primary_guest();

-- ── Row level security ──────────────────────────────────────────────────────

alter table booking_guests enable row level security;

drop policy if exists booking_guests_select   on booking_guests;
drop policy if exists booking_guests_write    on booking_guests;
drop policy if exists booking_guests_property on booking_guests;
create policy booking_guests_select on booking_guests for select
  using (has_permission('bookings.view') or has_permission('frontdesk.view'));
create policy booking_guests_write on booking_guests for all
  using (has_permission('frontdesk.checkin') or has_permission('guests.edit'))
  with check (has_permission('frontdesk.checkin') or has_permission('guests.edit'));
create policy booking_guests_property on booking_guests as restrictive for all
  using (can_access_property(property_id)) with check (can_access_property(property_id));

do $$
declare
  t record;
begin
  for t in select * from (values ('booking_guests', 'frontdesk')) as x (tbl, module) loop
    execute format('drop trigger if exists %I on %I', t.tbl || '_audit', t.tbl);
    execute format(
      'create trigger %I after insert or update or delete on %I for each row execute function audit_row(%L)',
      t.tbl || '_audit', t.tbl, t.module);
  end loop;
end;
$$;
