-- ============================================================================
-- 1. Rooms follow their booking's status automatically
-- 2. Staff records carry contact details the admin fills in
-- Run after 0002_room_photos.sql.
-- ============================================================================

-- ── Staff details ───────────────────────────────────────────────────────────
alter table staff add column if not exists phone     text not null default '';
alter table staff add column if not exists job_title text not null default '';

-- ── Room occupancy follows check-in / check-out ─────────────────────────────
-- Keeping this in the database means the rule holds no matter how a booking is
-- updated — the admin panel, a SQL edit, or anything added later.
create or replace function sync_room_status()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- Free the previously assigned room when the assignment moves or the stay ends.
  if tg_op = 'UPDATE' and old.room_id is not null
     and (old.room_id is distinct from new.room_id or new.status <> 'checked_in')
  then
    -- Only release a room we had marked occupied; never clobber maintenance
    -- or out-of-service, which a person set deliberately.
    update rooms
       set status = 'available'
     where id = old.room_id
       and status = 'occupied';
  end if;

  -- A checked-in booking with a room assigned occupies that room.
  if new.status = 'checked_in' and new.room_id is not null then
    update rooms
       set status = 'occupied'
     where id = new.room_id
       and status in ('available', 'occupied');
  end if;

  return new;
end;
$$;

drop trigger if exists bookings_sync_room_status on bookings;
create trigger bookings_sync_room_status
  after insert or update of status, room_id on bookings
  for each row execute function sync_room_status();

-- Releasing a room when its booking is deleted outright.
create or replace function release_room_on_delete()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if old.room_id is not null and old.status = 'checked_in' then
    update rooms set status = 'available'
     where id = old.room_id and status = 'occupied';
  end if;
  return old;
end;
$$;

drop trigger if exists bookings_release_room on bookings;
create trigger bookings_release_room
  after delete on bookings
  for each row execute function release_room_on_delete();

-- ── Backfill: reconcile existing data with the new rule ─────────────────────
update rooms set status = 'available'
 where status = 'occupied'
   and id not in (
     select room_id from bookings
      where status = 'checked_in' and room_id is not null
   );

update rooms set status = 'occupied'
 where status = 'available'
   and id in (
     select room_id from bookings
      where status = 'checked_in' and room_id is not null
   );
