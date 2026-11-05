-- ============================================================================
-- Front Office & Operations build-out, part 1: roles
--
--   1. Night audit is back (docs/pms-review.md §3). Its permission,
--      frontdesk.night_audit, was hidden from the Roles page while the
--      feature was out, and saving a role from that page deleted every key
--      the page did not show. It is re-granted to the roles that shipped with
--      it, in case a save removed it.
--   2. The standard hotel roles a property expects to find, as editable
--      system roles: Night Auditor, Reservations Agent, Front Office Cashier,
--      Guest Relations, F&B Manager and Banquet Manager.
--   3. The POS cashier loses folio.post. It allowed any charge on any guest
--      folio; charging an outlet bill to a room is pos.pay, which it keeps.
--
-- Later migrations in this series seed their own new permissions onto these
-- roles.
--
-- Run after 0026_drop_guest_portal.sql.
-- ============================================================================

-- ── 1. Night audit ──────────────────────────────────────────────────────────

insert into role_permissions (role_key, permission)
select r, p from (values
  ('manager', 'frontdesk.night_audit'),
  ('front_office_manager', 'frontdesk.night_audit')
) as seed (r, p)
where exists (select 1 from roles where key = seed.r)
on conflict do nothing;

-- ── 2. Standard roles ───────────────────────────────────────────────────────

insert into roles (key, name, description, is_system, is_superuser, requires_2fa, sort_order) values
  ('night_auditor',      'Night Auditor',
   'Runs the night shift: closes the business day, posts room charges, handles late arrivals and no-shows.',
   true, false, false, 13),
  ('reservations_agent', 'Reservations Agent',
   'Takes, changes and cancels bookings and group blocks, and collects deposits.',
   true, false, false, 14),
  ('fo_cashier',         'Front Office Cashier',
   'Guest bills: posts charges, takes payments, issues invoices and checks guests out.',
   true, false, false, 15),
  ('guest_relations',    'Guest Relations',
   'Looks after guests in house: requests, messages, VIP arrivals, feedback and lost & found.',
   true, false, false, 16),
  ('fb_manager',         'F&B Manager',
   'Runs the outlets: menus, prices, voids, outlet takings and the F&B team.',
   true, false, false, 17),
  ('banquet_manager',    'Banquet Manager',
   'Sells and runs events: enquiries, quotations, event orders and banquet billing.',
   true, false, false, 18)
on conflict (key) do nothing;

insert into role_permissions (role_key, permission)
select r, p from (values
  -- Night Auditor: the front desk at night, plus closing the day. No-shows
  -- are marked by night audit only for someone who may cancel bookings.
  ('night_auditor', 'dashboard.view'), ('night_auditor', 'bookings.view'),
  ('night_auditor', 'bookings.cancel'), ('night_auditor', 'frontdesk.view'),
  ('night_auditor', 'frontdesk.checkin'), ('night_auditor', 'frontdesk.checkout'),
  ('night_auditor', 'frontdesk.requests'), ('night_auditor', 'frontdesk.night_audit'),
  ('night_auditor', 'guests.view'), ('night_auditor', 'guests.edit'), ('night_auditor', 'guests.view_id'),
  ('night_auditor', 'folio.view'), ('night_auditor', 'folio.post'), ('night_auditor', 'folio.payment'),
  ('night_auditor', 'rooms.view'), ('night_auditor', 'rooms.status'),
  ('night_auditor', 'reports.view'), ('night_auditor', 'maintenance.report'),

  -- Reservations Agent: bookings end to end, deposits, no check-in.
  ('reservations_agent', 'dashboard.view'), ('reservations_agent', 'bookings.view'),
  ('reservations_agent', 'bookings.create'), ('reservations_agent', 'bookings.edit'),
  ('reservations_agent', 'bookings.cancel'), ('reservations_agent', 'bookings.groups'),
  ('reservations_agent', 'guests.view'), ('reservations_agent', 'guests.edit'),
  ('reservations_agent', 'folio.view'), ('reservations_agent', 'folio.payment'),
  ('reservations_agent', 'rooms.view'), ('reservations_agent', 'rates.view'),
  ('reservations_agent', 'maintenance.report'),

  -- Front Office Cashier: the guest bill. Cannot void or adjust (folio.adjust
  -- stays with the Front Office Manager and Finance).
  ('fo_cashier', 'dashboard.view'), ('fo_cashier', 'bookings.view'),
  ('fo_cashier', 'frontdesk.view'), ('fo_cashier', 'frontdesk.checkout'),
  ('fo_cashier', 'guests.view'), ('fo_cashier', 'folio.view'), ('fo_cashier', 'folio.post'),
  ('fo_cashier', 'folio.payment'), ('fo_cashier', 'folio.invoice'),
  ('fo_cashier', 'loyalty.redeem'), ('fo_cashier', 'pos.view'), ('fo_cashier', 'pos.pay'),
  ('fo_cashier', 'maintenance.report'),

  -- Guest Relations: the guest in house, not the bill.
  ('guest_relations', 'dashboard.view'), ('guest_relations', 'bookings.view'),
  ('guest_relations', 'frontdesk.view'), ('guest_relations', 'frontdesk.requests'),
  ('guest_relations', 'guests.view'), ('guest_relations', 'guests.edit'),
  ('guest_relations', 'rooms.view'), ('guest_relations', 'housekeeping.lost_found'),
  ('guest_relations', 'events.view'), ('guest_relations', 'reports.view'),
  ('guest_relations', 'maintenance.report'),

  -- F&B Manager: the outlets. Outlet takings are in the financial reports.
  ('fb_manager', 'dashboard.view'), ('fb_manager', 'pos.view'), ('fb_manager', 'pos.order'),
  ('fb_manager', 'pos.pay'), ('fb_manager', 'pos.manage'), ('fb_manager', 'events.view'),
  ('fb_manager', 'reports.view'), ('fb_manager', 'reports.financial'),
  ('fb_manager', 'hr.view'), ('fb_manager', 'hr.approve_leave'), ('fb_manager', 'maintenance.report'),

  -- Banquet Manager: events, short of approving their own quotations above
  -- the threshold (events.approve stays with the GM and Sales).
  ('banquet_manager', 'dashboard.view'), ('banquet_manager', 'events.view'),
  ('banquet_manager', 'events.book'), ('banquet_manager', 'events.quote'),
  ('banquet_manager', 'events.bill'), ('banquet_manager', 'events.manage'),
  ('banquet_manager', 'bookings.view'), ('banquet_manager', 'guests.view'),
  ('banquet_manager', 'rooms.view'), ('banquet_manager', 'reports.view'),
  ('banquet_manager', 'hr.view'), ('banquet_manager', 'hr.approve_leave'),
  ('banquet_manager', 'maintenance.report')
) as seed (r, p)
where exists (select 1 from roles where key = seed.r)
on conflict do nothing;

-- ── 3. POS cashier ──────────────────────────────────────────────────────────

delete from role_permissions where role_key = 'pos_cashier' and permission = 'folio.post';
