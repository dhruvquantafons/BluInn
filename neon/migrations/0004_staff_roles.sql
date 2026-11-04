-- ============================================================================
-- Wider set of staff roles, and the policies that go with them.
-- Run after 0003_room_status_and_staff.sql.
--
-- Roles are permission tiers, not job titles. Someone's actual job — Waiter,
-- Head Chef, Night Manager — goes in staff.job_title, which is free text.
--
--   admin         everything, including rates, photos and staff accounts
--   manager       bookings, rooms, rates and photos; cannot manage accounts
--   front_desk    bookings and rooms
--   housekeeping  rooms only
-- ============================================================================

alter type staff_role add value if not exists 'manager';
alter type staff_role add value if not exists 'housekeeping';

-- The helpers below compare role::text rather than an enum literal, so this
-- file works whether or not the values above were committed in a prior
-- transaction. Without that cast Postgres can refuse to resolve a value added
-- in the same transaction.

create or replace function is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff
     where id = auth.uid() and is_active and role::text = 'admin'
  );
$$;

-- Rates, room photography and other commercial settings.
create or replace function can_manage_rates()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff
     where id = auth.uid() and is_active and role::text in ('admin', 'manager')
  );
$$;

-- Reservations and guest records.
create or replace function can_manage_bookings()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from staff
     where id = auth.uid() and is_active
       and role::text in ('admin', 'manager', 'front_desk')
  );
$$;

-- ── Re-scope the policies ───────────────────────────────────────────────────

drop policy if exists room_types_write    on room_types;
drop policy if exists extra_charges_write on extra_charges;

create policy room_types_write on room_types
  for all using (can_manage_rates()) with check (can_manage_rates());

create policy extra_charges_write on extra_charges
  for all using (can_manage_rates()) with check (can_manage_rates());

drop policy if exists bookings_all      on bookings;
drop policy if exists booking_notes_all on booking_notes;
drop policy if exists guests_all        on guests;

create policy bookings_all on bookings
  for all using (can_manage_bookings()) with check (can_manage_bookings());

create policy booking_notes_all on booking_notes
  for all using (can_manage_bookings()) with check (can_manage_bookings());

create policy guests_all on guests
  for all using (can_manage_bookings()) with check (can_manage_bookings());

-- Rooms stay open to every active staff member, housekeeping included.

-- Room photography in storage follows the rates permission.
drop policy if exists "admins upload room photos" on storage.objects;
drop policy if exists "admins update room photos" on storage.objects;
drop policy if exists "admins delete room photos" on storage.objects;

create policy "staff upload room photos" on storage.objects
  for insert with check (bucket_id = 'room-photos' and public.can_manage_rates());

create policy "staff update room photos" on storage.objects
  for update using (bucket_id = 'room-photos' and public.can_manage_rates());

create policy "staff delete room photos" on storage.objects
  for delete using (bucket_id = 'room-photos' and public.can_manage_rates());
