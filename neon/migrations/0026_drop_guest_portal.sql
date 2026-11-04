-- ============================================================================
-- BluInn is staff-only: retire the guest portal and the public website
--
-- 0021 and 0023 gave signed-in guests their own read path into the database,
-- and 0001, 0006, 0020 and 0021 let anyone holding the public (anon) key read
-- the tariff, applied price changes and public promo codes, because a public
-- website rendered them. Both front ends are gone. BluInn is the back office,
-- so every row is now read by staff or not at all.
--
--   • The guest-scoped policies and functions are dropped.
--   • can_access_property() loses its guest and public-website branches.
--   • handle_new_user() no longer needs the is_guest escape hatch: a login is
--     only ever created by an administrator (or is the very first one).
--   • The "public" read policies keep the condition they had, plus is_staff(),
--     so front-desk staff without rates/revenue permissions still read the
--     applied prices and public promo codes they quote from.
--
-- Columns the portal added (guests.auth_user_id, guests.account_created_at,
-- properties.best_rate_message, group_settings.best_rate_message) are left in
-- place: the app no longer reads them, and property_settings is a `select *`
-- view over properties, so dropping a column means rebuilding that view.
-- See docs/client-era-audit.md.
--
-- Supersedes 0021_guest_portal.sql and 0023_guest_password_login.sql.
-- Run after 0025_event_tax_in_gst_return.sql.
-- ============================================================================

-- ── Guest-scoped read policies ──────────────────────────────────────────────

drop policy if exists guests_own_select         on guests;
drop policy if exists bookings_own_select       on bookings;
drop policy if exists payment_tx_own_select     on payment_transactions;
drop policy if exists folio_entries_own_select  on folio_entries;
drop policy if exists notifications_own_select  on notifications;

-- ── Property scoping without guests or a public website ─────────────────────

/*
 * A null property_id is a row that belongs to the group (a message template
 * every property inherits). Otherwise staff see the property they are working
 * in, and nobody else sees anything.
 */
create or replace function can_access_property(p uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select case
    when p is null then true
    when is_staff() then p = current_property()
    else false
  end;
$$;

-- ── Sign-up bootstraps the first administrator, nothing else ────────────────

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  -- A project that already has staff creates them through Staff.
  if exists (select 1 from public.staff) then
    return new;
  end if;

  insert into public.staff (id, email, full_name, role)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''), 'admin')
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ── Guest portal functions ──────────────────────────────────────────────────

drop function if exists guest_cancel_booking(uuid, text);
drop function if exists guest_update_profile;
drop function if exists guest_link_account();
drop function if exists portal_settings();
drop function if exists auth_used_password();
drop function if exists current_guest();

-- ── Anonymous reads become staff reads ──────────────────────────────────────

drop policy if exists room_types_public_read on room_types;
create policy room_types_public_read on room_types for select using (is_staff());

drop policy if exists extra_charges_public_read on extra_charges;
create policy extra_charges_public_read on extra_charges for select using (is_staff());

drop policy if exists rate_plans_select on rate_plans;
create policy rate_plans_select on rate_plans for select using (is_staff());

drop policy if exists rate_seasons_select on rate_seasons;
create policy rate_seasons_select on rate_seasons for select using (is_staff());

drop policy if exists rate_restrictions_select on rate_restrictions;
create policy rate_restrictions_select on rate_restrictions for select using (is_staff());

drop policy if exists package_components_select on package_components;
create policy package_components_select on package_components for select using (is_staff());

-- Every booking is priced with the applied adjustments, so any staff member
-- reads those; the full history stays behind revenue.view / rates.view.
drop policy if exists pricing_adjustments_public on pricing_adjustments;
create policy pricing_adjustments_public on pricing_adjustments for select
  using (status = 'applied' and is_staff());

-- The desk may apply a public promo code without revenue.view.
drop policy if exists promo_codes_public on promo_codes;
create policy promo_codes_public on promo_codes for select
  using (is_active and is_public and is_staff());

-- currencies_select (0015) already lets staff read every currency.
drop policy if exists currencies_public_select on currencies;
