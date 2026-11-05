-- ============================================================================
-- Fewer shipped roles
--
-- Four system roles are dropped from the set BluInn ships with:
--
--   fo_cashier              Front Office Cashier   (0027) — Front Desk Agent covers it
--   hr_manager              HR Manager             (0012) — the GM holds every HR permission
--   sales_marketing         Sales & Marketing      (0005) — the GM holds rates, revenue and events
--   maintenance_supervisor  Engineering Supervisor (0011) — the GM holds maintenance.manage
--
-- A hotel that wants any of them can create it again under Admin → Roles.
--
-- A role still held by a staff member is kept (staff.role references it), so
-- no one loses access; it simply stops being a system role, which lets an
-- administrator delete it from the Roles page once nobody holds it.
-- Its permissions go with it (role_permissions cascades).
--
-- Run after 0034_event_equipment_clash.sql.
-- ============================================================================

do $$
declare
  v_key text;
begin
  foreach v_key in array array['fo_cashier', 'hr_manager', 'sales_marketing', 'maintenance_supervisor'] loop
    if exists (select 1 from staff where role = v_key) then
      update roles set is_system = false where key = v_key;
      raise notice 'Role % is still held by staff; kept as a custom role', v_key;
    else
      delete from roles where key = v_key;
    end if;
  end loop;
end;
$$;
