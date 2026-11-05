-- ============================================================================
-- Front Office & Operations build-out, part 8: equipment is not promised twice
--
-- A hotel with one projector cannot put it in two functions that overlap.
-- Equipment was only shown with its "qty available" while quoting (0019,
-- and docs/client-era-audit.md B4: "with one hall, two functions can't
-- overlap"); with several spaces they can.
--
-- Same rule as the space itself: only a confirmed or completed event holds
-- equipment, over its whole hold window (setup_from → teardown_to). Quotes
-- and enquiries may overlap freely. Checked when an equipment line is added
-- or changed on a holding event, and when an event is confirmed or moved.
--
-- Run after 0033_inventory.sql.
-- ============================================================================

create or replace function event_equipment_check(p_event uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
declare
  v_e     record;
  v_clash record;
begin
  select id, event_date, setup_from, teardown_to, status into v_e from event_bookings where id = p_event;
  if v_e.id is null or v_e.status not in ('confirmed', 'completed') then return; end if;

  -- One lock per piece of equipment and day, in a fixed order.
  perform pg_advisory_xact_lock(hashtextextended('event_equipment:' || l.equipment_id::text || ':' || v_e.event_date::text, 0))
     from (select distinct equipment_id from event_lines where event_id = p_event and equipment_id is not null order by 1) l;

  select eq.name, eq.qty_available, sum(l.qty) as wanted
    into v_clash
    from (select distinct equipment_id from event_lines where event_id = p_event and equipment_id is not null) mine
    join event_equipment eq on eq.id = mine.equipment_id
    join event_lines l on l.equipment_id = mine.equipment_id
    join event_bookings e on e.id = l.event_id
   where e.status in ('confirmed', 'completed')
     and e.event_date = v_e.event_date
     and e.setup_from < v_e.teardown_to
     and e.teardown_to > v_e.setup_from
   group by eq.id, eq.name, eq.qty_available
  having sum(l.qty) > eq.qty_available
   limit 1;

  if v_clash.name is not null then
    raise exception 'EVENT_EQUIPMENT_CLASH: % — % needed at once, % owned', v_clash.name, v_clash.wanted, v_clash.qty_available;
  end if;
end;
$$;

create or replace function event_lines_equipment_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.equipment_id is not null then
    perform event_equipment_check(new.event_id);
  end if;
  return new;
end;
$$;

drop trigger if exists event_lines_equipment on event_lines;
create trigger event_lines_equipment after insert or update of equipment_id, qty on event_lines
  for each row execute function event_lines_equipment_check();

create or replace function event_bookings_equipment_check()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status in ('confirmed', 'completed')
     and (old.status is distinct from new.status or old.event_date <> new.event_date
          or old.setup_from <> new.setup_from or old.teardown_to <> new.teardown_to) then
    perform event_equipment_check(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists event_bookings_equipment on event_bookings;
create trigger event_bookings_equipment after update of status, event_date, setup_from, teardown_to on event_bookings
  for each row execute function event_bookings_equipment_check();
