# BluInn PMS review (November 2026)

This review looks at BluInn from two angles: a full-stack engineer's and a hotel manager's. It covers four
areas:

1. The database design (migrations `0001`–`0026`).
2. Roles and permissions.
3. What a Front Office and an Operations section normally contain, compared with what BluInn has.
4. What a Commercial section normally contains (added later in November 2026).

Severity levels: **Critical** must be fixed before a paying hotel goes live. **High** should be fixed soon.
**Medium** can be fixed as part of related work.

References are `file:line`. A bare `00NN:line` means `neon/migrations/00NN_*.sql`.

**Status (5 Nov 2026).** Section 3 (Front Office and Operations) is built, in migrations `0027`–`0034`.
The chosen part of section 4 (GST invoices, credit notes, the flash report) is built in `0036`–`0037`.
Sections 1 and 2 are only partly addressed by that work. The rest is queued for a dedicated security and
financial-integrity pass; see [What was fixed](#what-was-fixed).

---

## 1. Database design

### What is already right

- **Money:** every money column is `numeric`. There is no `float`, `real` or `money` type anywhere.
- **Time:** all timestamps are `timestamptz`. Stay and business dates are `date`.
- **Row level security:** every table has RLS enabled and policies.
  - The one exception is `login_attempts`. It has no policies, so it is deny-all, which is deliberate.
- **Function hardening:** every `SECURITY DEFINER` function sets `search_path`.
- **Audit trail:** `audit_log` is append-only and written by triggers. Changes are recorded however they
  reach the database.
- **Invoices:** issued invoices are snapshotted and protected by a trigger, though that trigger has gaps
  (see 1.3).
- **Multi-property:** since `0024`, every operational table has a backfilled, indexed `property_id NOT NULL`
  and a restrictive property policy.
- **Uniqueness:** keys are unique per property where they should be (room numbers, rate plan codes, invoice
  numbers and so on).

### Critical

#### 1.1 Revoked property access keeps working
`current_property()` returns `staff.active_property_id` without checking that the person can still access
that property (`0024:117-124`). Every per-property policy then trusts it through `can_access_property()`
(`0026:43-50`).

- **Failure:** an administrator removes someone's access to Hotel B while Hotel B is selected in that
  person's switcher. They keep full read and write access to Hotel B.
- **Escalation:** `staff_properties_write` needs only `staff.manage` (`0024:101`). The restrictive staff
  policy lets a person update their own row (`0024:500`). So a `staff.manage` holder can give themselves
  `all_properties` or any property.
- **Fix:** have `current_property()` intersect with `staff_property_ids()`. Restrict who may write
  `staff_properties`, `all_properties` and `property_id`.

#### 1.2 Deletes cascade away financial and legal history
| Deleting | Also deletes | Allowed for |
|---|---|---|
| A booking | folio entries and folios (`0007:156`, `0014:50,66`), payment transactions (`0014:260`), refund requests (`0014:289`), registration cards (`0008:17`), key-card events, guest requests, notifications, room moves | `staff.manage` (`0007:444`) |
| A guest | identity record, ID scans (the stored files are orphaned), loyalty transactions (`0016:109`) | `guests.edit`, `bookings.create` or `frontdesk.checkin`, because `guests_write` is `FOR ALL` (`0007:451`) |
| A POS order | its lines and payments (`0017:212,239`) | `pos.order` (`0017:826`) |
| An event | its lines and payments (`0019:364,384`) | `events.book` (`0019:1296`) |
| A staff member | attendance, shifts, leave, feedback (`0012:116,141,266,286`) | `staff.manage` |
| A room | Sets `bookings.room_id` to null, so stay history loses the room. There is no `is_active` flag on rooms | `rooms.manage` |

**Fix:** use `ON DELETE RESTRICT` on financial and legal children. Remove `DELETE` from these policies
(cancel or void instead). Add `rooms.is_active`.

#### 1.3 Records that should be immutable can be edited
- **Folio entries.** `folio_void` is a plain `UPDATE` policy (`0007:423`), and no trigger limits which columns
  change. A `folio.adjust` holder can change the `amount` of a posted line, even after night audit has
  stamped it.
- **City ledger.** `city_ledger_write` is `FOR ALL` (`0015:357`), although the comment says rows are never
  edited.
- **Invoices.** The invoice immutability trigger (`0014:233-241`) compares columns with `<>`, which does not
  catch changes to or from NULL. It also skips `event_id`, `property_id`, `company_id`, `bill_to_address` and
  `place_of_supply`.
- **Bookings and housekeeping tasks.** `bookings_update ... with check (true)` (`0007:442`) lets anyone with
  `frontdesk.checkin` write any column, including `penalty_waived` and `total_amount`.
  `hk_tasks_update ... with check (true)` (`0009:326`) lets a housekeeper mark their own task inspected.
- **POS and pricing:**
  - POS order lines stay editable after the bill is settled (`0017:834`).
  - Pricing adjustments can be inserted already applied, skipping approval (`0020:582`).
  - Event bookings can be set to confirmed directly (`0019:893`).

#### 1.4 Anyone can execute every function
`db/platform.sql:163` grants `EXECUTE` on all functions to `anon`, and no migration revokes it. Several
`SECURITY DEFINER` functions have no permission check:

| Function | What a caller can do |
|---|---|
| `next_invoice_number`, `next_event_number`, `next_pos_order_number` | Burn numbers. GST invoice numbering then has gaps |
| `loyalty_expire_points` | With a far-future date, wipe every point in the group |
| `master_folio`, `hk_create_task`, `pos_recalc_order`, `event_recalc` | Create or recalculate records |
| `folio_balance_of`, `company_balance`, `loyalty_balance` | Read balances across properties |

On Neon the database API runs in-process and is not reachable from the browser. On Supabase and the desktop
build, PostgREST exposes these as `/rpc/*` endpoints (`desktop/lib/gateway.js`).

#### 1.5 The Razorpay webhook can credit a folio twice
`app/api/payments/razorpay/webhook/route.ts:67-136` runs three steps as separate transactions: read
`folio_entry_id`, insert a payment, then update the transaction.

- Two simultaneous deliveries both see `folio_entry_id` as null, and both post a credit.
- The result of the final update is never checked.

**Fix:** a single SQL function that does `update ... where folio_entry_id is null returning`, then inserts.

#### 1.6 Invoice numbering has gaps, and a folio can be invoiced twice
`app/(bluinn)/billing-actions.ts:127-195` checks whether the folio is already invoiced, claims a number, then
inserts the invoice. Each step is its own transaction.

- A failed insert leaves a gap in the GST sequence.
- Two clicks at the same moment produce two issued invoices for one folio, because there is no partial unique
  index on `invoices(folio_id) where status = 'issued'`.
- The database never checks that `number` matches `series/financial_year/seq`.

### High

#### 1.7 GST compliance gaps
- **Outlet cash sales are missing from the GST summary.** `report_tax_summary` (`0025:26-47`) reads folio
  charges and event bills, and an outlet bill paid in cash never touches a folio.
- **No credit notes.** A mistake can only be fixed by cancelling the invoice, which does not reverse an
  invoice already filed in a return.
- **No line-level tax detail.** There is no HSN/SAC code and no CGST/SGST/IGST split on lines;
  `tax_breakdown` holds only `{rate, net, tax}`.
- **No buyer GSTIN.** `bill_to_gstin` and `bill_to_address` are always written as `""`
  (`billing-actions.ts:183-185`).
- **Allowances don't reduce GST.** An `adjustment` reduces the folio balance, but the tax summary never
  subtracts it (`0019:1099`, `0025:31`).
- **Shared GSTIN collisions.** Every property defaults to the `INV` prefix (`0014:37`). Two hotels under one
  GSTIN would both issue `INV/2026-27/0001`.

#### 1.8 Double-booking protection has holes
There is no exclusion constraint. Double-booking is prevented only by the `enforce_booking_inventory` trigger
(`0007:200-306`), which has these gaps:

- A booking with no `room_type_id` takes no inventory (`0007:252`). Deleting a room type sets
  `room_type_id` to null on all its bookings.
- Capacity is counted by the booked type, not the assigned room (`0007:277`). An upgrade into the last
  Luxury room leaves Luxury showing one room free, so it can be sold again.
- A room set to `out_of_order` by hand, with no block, stays sellable. "Sellable" is defined three ways
  (`0006:298`, `0024:524`, `0024:1157`).
- A `room_blocks` insert never checks for bookings already assigned to the room (`0006:317`).
- A booking with `rooms_count > 1` has a single `room_id`.

#### 1.9 Charge-to-room overcharges after a partial payment
`pos_charge_to_room` posts the full bill total to the folio but records only the amount still owing as the
room-charge payment (`0017:585-609`). Part of an outlet bill paid in cash is charged again to the room.
`event_post_to_folio` already handles this correctly with an offsetting credit.

#### 1.10 Rows are filed under the wrong property
Child tables default `property_id` to the caller's `current_property()` instead of their parent's
(`0024:361-371`). This includes housekeeping tasks, registration cards, identities, folios, invoices,
attendance and POS orders. In the service context (cron jobs, webhooks, the attendance device) that resolves
to the default property.

- **Attendance:** a biometric clock-in at Hotel B is filed under the default hotel.
- **Folios:** a webhook payment at B creates the folio under A.
- **Maintenance SLA:** cron reads the default property's SLA (`0011:163`).
- **Scheduled reports are likely broken.** `is_service_role()` checks `current_setting('role')` (`0018:50`).
  The app's service context never runs `SET ROLE` (`app/lib/neon/db.ts:79-81`), so every `report_*` call
  from cron should raise "not permitted". Also, `report_*` functions take no property argument, so every
  schedule would get the default property's figures.
- **Cross-property links:** foreign keys are not composite, so a booking at A can point at a room at B.
  `merge_guests`, `erase_guest`, `pos_charge_to_room` and `event_post_to_folio` don't check the target row's
  property.

### Medium

- **Four meanings of "today":**
  - `properties.business_date`
  - `hk_business_today()` (the wall-clock local date, `0009:149`)
  - `local_day()` (`0018:62`)
  - UTC `current_date` (`0013:53`)
  
  `properties.timezone` is unvalidated. An invalid zone breaks every report.
- **Booking terms are not stored on the booking.** Cancellation, no-show and deposit terms are read live
  from `rate_plans`. Editing or deleting a plan changes the penalties on existing bookings (`0007:97`). There
  is no status-transition guard: nothing stops `checked_out → confirmed`.
- **Privacy:**
  - `erase_guest` leaves the guest's personal data in `audit_log` before-images and in `notifications`.
  - `merge_guests` deletes the dropped guest, which cascades away their loyalty history instead of moving it
    (`0013:131`).
  - `loyalty_erase` deletes points history even though its own comment says the rows stay (`0016:612-625`).
- **Refunds:**
  - Approval isn't enforced in SQL. The self-approval trigger can be bypassed by leaving `decided_by` null
    (`0014:316`).
  - Event refunds have no cap and no approval (`0019:986`).
  - A partial gateway refund can't be represented.
- **Missing CHECK constraints:**
  - `bookings.quoted_rate`, `total_amount` and `promo_discount` ≥ 0
  - `folio_entries.tax_rate` range
  - `tax_slabs` jsonb shape
  - GSTIN format
- **Missing indexes:**
  - composites such as `(property_id, status, check_in)` and `(property_id, check_out)`
  - foreign keys: `bookings.rate_plan_id`, `split_from_id`; `room_moves.to_room_id`;
    `key_card_events.booking_id`; `invoices.folio_id`; `pos_payments.booking_id`;
    `promo_redemptions.booking_id`
- **Inconsistent `updated_at`:** some tables have the column but no trigger, and others don't have it.
- **Duplicated concepts:**
  - out-of-order state in both `rooms.status` and `room_blocks`
  - occupancy as `room_types.occupancy` text and as `max_adults`
- **Promo limits** are checked only in the app (`app/lib/revenue.ts:349`), so concurrent redemptions can
  exceed them.
- **Global currencies:** `currencies` has one base currency for the whole group, so a second property can't
  have a different base currency.
- **RLS performance:** `can_access_property()` is a `SECURITY DEFINER` SQL function. It isn't inlined, so it
  runs per row. Use `property_id = (select current_property())` so it is evaluated once.
- **Overnight events can't be entered.** `event_bookings` uses `time` columns with `end_time > start_time`
  on one date, so a 19:00–01:00 wedding fails.
- **First-admin race:** two simultaneous first sign-ups could both become admin (`0026:54`).
- **Migration runner:** `scripts/db-migrate.mjs` records file names only, with no checksums. An edited
  migration silently diverges between environments.
- **Leftovers:**
  - `guests.auth_user_id`, `account_created_at`, `best_rate_message`
  - the public `room-photos` bucket
  
  Already tracked in [client-era-audit.md](client-era-audit.md).

---

## 2. Roles and permissions

### Model
The model is sound:
- Roles are rows (`roles`) with a configurable set of text keys (`role_permissions`), grouped by module and
  action (`app/lib/permissions.ts`).
- `has_permission()` backs every RLS policy (`0005:147`).
- Per-role 2FA, session revocation and a superuser flag are supported.
- Server actions re-check permissions through `requirePermission()` (`app/lib/auth.ts`).

### Defects

| # | Severity | Finding |
|---|---|---|
| R1 | **Critical (bug)** | **Saving a role deletes keys the UI doesn't show.** `saveRole` (`app/(bluinn)/actions.ts:238-247`) deletes every row for the role, then re-inserts only keys that pass `isPermission()`. `frontdesk.night_audit`, `companies.manage` and `folio.city_ledger` are still referenced by RLS and functions (`0007:420,441`, `0009:216`, `0024:897,965`). They disappear the first time someone saves General Manager, Front Office Manager or Finance |
| R2 | **Critical** | **Privilege escalation.** `staff_update` (`0005:200`) lets any `staff.manage` holder give anyone the `admin` role; the app only stops people changing their own role. `roles_write` lets any `roles.manage` holder set `is_superuser = true` or grant themselves anything. Only a superuser should be able to assign a superuser role or change `is_superuser` |
| R3 | High | **Seeds that are too broad:** <br>• `pos_cashier` has `folio.post`, which allows any charge on any folio. <br>• `front_desk` has `folio.invoice`, which includes *cancelling* tax invoices. <br>• `bookings.edit` covers "dates, rooms **and rates**" with no limit |
| R4 | High | **Keys too coarse for separation of duties:** <br>• payment vs refund (`folio.payment`) <br>• issue vs cancel invoice (`folio.invoice`) <br>• allowance or discount vs void (`folio.adjust`) <br>• amend vs rate override (`bookings.edit`) <br>No monetary limits per role, such as a maximum discount % or allowance ₹ |
| R5 | Medium | **One role per person across every property.** `staff.role` is a single value; `staff_properties` only grants access. A group can't make someone GM at Hotel A and Front Desk at Hotel B. Move the role onto `staff_properties` |
| R6 | Medium | **Roles are group-wide.** A property GM with `roles.manage` changes roles for every hotel |
| R7 | Low | Notifications is shown to anyone with `guests.view`, `settings.manage` or `audit.view` (`components/nav.ts:134`) |

### Standard hotel roles that are missing
Night Auditor, Reservations Agent, Front Office Cashier, Guest Relations or Concierge, F&B or Outlet Manager
(`pos.manage` only goes to GM and Finance today), Banquet or Events Manager, Revenue Manager (only GM holds
`revenue.approve`), Owner or read-only Auditor, Security.

---

## 3. Front Office and Operations: what a PMS normally includes

Sources: the industry PMS evaluation checklists for front office, reservations, cashiering and end-of-day,
and housekeeping; Oracle OPERA documentation; and Form C guidance (listed at the end).

### What BluInn already does well
- **Reservations:** individual, group and split bookings, waitlist, room moves, tape chart, rate plans,
  restrictions, packages, promos.
- **Check-in:** ID capture, an e-signed registration card, and an inspected-room requirement.
- **Guest requests:** wake-up calls, messages, complaints, housekeeping and maintenance requests.
- **Integrations and guests:** a key-card hook, loyalty, duplicate merge and GDPR-style erasure.
- **Billing:** folios with split folios, GST invoices, refund approval, multi-currency settlement.
- **Housekeeping:** tasks, inspection, zones, checklists (linen, amenities, minibar), DND, lost and found.
- **Maintenance:** tickets with SLA and escalation, assets, preventive schedules, room blocks.
- **Outlets and events:** POS with seven outlet types, kitchen tickets and charge to room. Events with diary,
  quotation, contract and BEO.

### Front Office gaps

| Priority | Feature | Why a hotel needs it | Today |
|---|---|---|---|
| 1 | **Night audit and business date** | Posts room and tax each night, processes no-shows, releases expired holds, closes the day so past postings are locked, keeps a daily report, and rolls the date | Removed in Nov 2026. Room charges post only at check-out, no-shows are marked by hand, reports are live. **Being reinstated** |
| 2 | **Cashier shifts, cash drawer, paid-outs** | Opening float, cash-up and variance per cashier; petty cash and paid-outs; the night audit checks for open drawers | None |
| 3 | **Walk-in fast path** | Availability, booking, room, registration and check-in on one screen | Three separate screens |
| 4 | **Sharers and accompanying guests** | Each adult in the room needs an ID on record | Free text on the registration card |
| 5 | **Form C (FRRO, India)** | Foreign guests must be reported within 24 hours of arrival | **Not planned** (decided Nov 2026). Hotels file Form C on the FRRO portal themselves; BluInn records the passport and visa number |
| 6 | **Traces** | Date-driven internal follow-ups for a department ("extra bed in 204 on the 12th") | Not available |
| 7 | **VIP, birthday and anniversary alerts; airport pickup and drop list** | Standard arrival briefing | Guest tags exist, but there is no arrival alert or transport list |
| 8 | **Deposits and proforma invoice** | Deposit due date and status, deposit-due list, proforma for advance payment | Only a `deposit_required` flag |
| 9 | **Complimentary and house use** | Zero-rated stays approved by a manager and excluded from ADR | Not available |
| 10 | **Room move or upgrade reason** | Upgrade tracking and audit | Free text |

### Operations gaps

| Priority | Feature | Today |
|---|---|---|
| 1 | **Stay-over and touch-up cleaning** | Removed for the original client (`0010`); a standard PMS has it. Restore as a per-property setting |
| 2 | **Room discrepancy (skipper/sleeper)** | Housekeeping's occupancy report vs front office status. Not available |
| 3 | **Out-of-order rooms leave inventory** | Not enforced (see 1.8) |
| 4 | **Minibar and laundry posting from housekeeping** | Mini-bar and laundry outlets exist, but nothing can be posted from a housekeeping task |
| 5 | **Charge-to-room correctness** | Overcharges (see 1.9) |
| 6 | **Inventory and stores** | Not available: no par levels, no issue to department, no amenity, linen or minibar stock, no outlet recipes |
| 7 | **Event equipment clash check, several spaces** | One-hall assumption (client-era B4) |

---

## 4. Commercial: what a PMS normally includes

The Commercial section is Rates, Revenue, Billing, Reports and Notifications. The comparison is against PMS
vendor documentation (rate plans, restrictions, derived rates, packages), revenue-reporting guides (pace,
pickup, segment, flash) and India's GST invoicing rules.

### What BluInn already does well

- Rate plans with meal-plan labels, packages, seasons, and all five restrictions (MinLOS, MaxLOS, CTA, CTD,
  stop-sell), enforced by the pricing engine (`app/lib/pricing.ts`).
- Dynamic pricing rules with floor, ceiling and an approval threshold; promo codes with limits; competitor
  rates entered by hand.
- Per-property invoice series by financial year; refund approval with a second person; Razorpay links.
- Occupancy, ADR, RevPAR and GOPPAR, twelve fixed reports, CSV export and scheduled emails.

### Gaps

| Area | Gap | Decision |
|---|---|---|
| Billing | Single-rate tax summary only: no SAC code, no CGST/SGST/IGST, buyer GSTIN always blank (1.7) | **Built** (`0036`) |
| Billing | No credit notes; the only correction is cancelling the invoice | **Built** (`0036`) |
| Billing | Allowances never reduce taxable value; outlet bills paid at the outlet missing from the tax summary (1.7) | **Built** (`0036`) |
| Billing | No GSTR-1 register (B2B, B2C, credit notes, SAC summary, document summary) | **Built** (`0036`) |
| Reports | No manager's flash report (day, MTD, YTD against last year, revenue by department) | **Built** (`0037`) |
| Billing | Numbered proforma invoice | Not now |
| Billing | E-invoicing (IRN) for turnover above ₹5 crore | Not now: needs a GSP/IRP integration |
| Sales | Market-segment and source-of-business masters; travel agents with commission | Declined for now |
| Rates | Rate calendar grid; derived (child) rate plans; priced meal plans | Declined for now |
| Rates | Channel allocations stored but never enforced | Declined for now |
| Reports | Pace and pickup, budget against actual | Declined for now |
| Distribution | Channel manager / OTA connection | Not now: revisit with a chosen partner |

---

## What was fixed

The Front Office and Operations build-out (migrations `0027`–`0034`) covers these items:
- R1 and part of R3
- the missing Front Office and Operations roles
- every row in the two gap tables above
- the folio-entry immutability part of 1.3
- the out-of-order part of 1.8
- 1.9

The Commercial build-out (`0036`–`0037`) covers 1.7 apart from shared-GSTIN prefix collisions, and the invoice
part of 1.3: `invoices_immutable()` now freezes every column with `is distinct from`.

**Queued for a dedicated security and financial-integrity pass:** 1.1, 1.2, the rest of 1.3, 1.4, 1.5, 1.6,
the shared-GSTIN part of 1.7, the rest of 1.8, 1.10, R2, R4–R7, and the Medium list.

## Build-out reference

| Migration | What it adds | Where in the app |
|---|---|---|
| `0027_front_office_roles` | Six system roles: Night Auditor, Reservations Agent, Front Office Cashier, Guest Relations, F&B Manager, Banquet Manager. Night audit re-granted to GM and FOM. `folio.post` taken from the POS cashier | **Admin → Roles**. `saveRole` now keeps keys the page does not show |
| `0028_night_audit_lock` | Folio lines immutable after posting, apart from void, folio move and the audit stamp. A closed day cannot be voided, and lines are never deleted | **Front Office → Night audit**, status bar, dashboard alert. **Folio → Allowance** corrects a closed line |
| `0029_cashier_shifts` | `cashier_shifts`, `cash_movements`, shift tagging of cash payments, and the optional "cash needs an open shift" rule | Cash shift card on **Front desk** and **Point of sale**; **Front Office → Cash shifts** with the printable shift report |
| `0030_room_guests` | `booking_guests` (everyone in the room, the booker recorded as the main guest by trigger) and `guests.gender` | Check-in form; **Guests in the room** on the booking; registration card lists sharers |
| `0031_front_desk_extras` | Traces with a department, pick-up and drop, deposit due date, complimentary and house-use stays (approved, zero-rated, out of ADR), room-move reason codes | Front desk panels (transfers, deposits due); traces on the housekeeping and maintenance boards; **Booking → Edit → Arrangements** |
| `0032_operations` | Stay-over task generation (setting), room reports and `room_discrepancies`, the block-versus-guest guard, minibar and laundry from housekeeping, the charge-to-room fix, frozen POS lines, check-in override | **Housekeeping → My tasks** (room report, charge to guest), discrepancies and laundry on the boards, override on check-in |
| `0033_inventory` | Locations, items, signed movement ledger, `stock_levels`; automatic consumption when bills settle and rooms are cleaned | **Operations → Inventory** (stock, movements, items and locations) |
| `0034_event_equipment_clash` | Equipment cannot be over-committed across overlapping confirmed functions | **Events → Setup** adds several spaces |
| `0035_trim_roles` | Drops four shipped roles: Front Office Cashier, HR Manager, Sales & Marketing, Engineering Supervisor. A role still held by a staff member is kept as a custom role | **Admin → Roles** lists 14 system roles |
| `0036_gst_invoicing` | Tax regime, GST state code, default SAC codes and credit-note prefix per property; SAC per outlet. SAC and revenue department on every folio charge, filled in by trigger. Allowances that name a charge carry its tax. GST facts frozen on invoices. `credit_notes` and `credit_note_issue()` (own series, 30 November limit). Cancel window: the 11th of the next month, and never once a credit note exists. `report_tax_summary` by SAC with CGST/SGST/IGST, including outlet bills and less allowances and credit notes. `gst_outlet_sales()` | **Folio → Issue invoice** (bill-to, buyer GSTIN), **Issue credit note** under each invoice, **Allowance → Against charge**. GST print layout for room and event invoices. **Billing → Credit notes** and **GST register** (CSVs for GSTR-1). **Settings → Tax** and **POS → Menu** (SAC) |
| `0037_flash_report` | `flash_period()` and `report_flash()`: day, month and financial year to date against last year; rooms, ADR, RevPAR, revenue by department, the day's movements, the week ahead, in-house balances | **Reports → Flash**, linked from each night-audit day report |

**New permissions:**
- `frontdesk.night_audit`, `frontdesk.checkin_override`
- `folio.cashier`, `folio.cashier_audit`
- `bookings.complimentary`
- `housekeeping.post_charges`
- `inventory.view`, `inventory.manage`
- `folio.credit_note` (`0036`)

**New property settings:**
- `require_cashier_shift`
- `hk_stayover_enabled`

Both are off by default.

From `0036`:
- `tax_regime`: `gst` by default, `simple` for a property whose country is not India.
- `gst_state_code`: taken from the GSTIN.
- `sac_room`, `sac_fnb`, `sac_event`, `sac_other`.
- `credit_note_prefix`: `CN`.

**Tests:**
- `neon/tests/behaviour.sql` has EXPECT checks for every new rule.
- Unit tests: `tests/cashier.test.ts`, `tests/front-desk.test.ts`, `tests/inventory.test.ts`, `tests/gst.test.ts`,
  `tests/gst-register.test.ts`, and the flash helpers in `tests/reports.test.ts`.

## Sources

- [Hotel Software or PMS Demo Checklist – Front Office Functions](https://setupmyhotel.com/hotel-formats/front-office-formats/hotel-software-or-pms-demo-checklist-front-office-functions/)
- [Hotel Software or PMS Demo Checklist – Reservation Functions](https://setupmyhotel.com/hotel-formats/front-office-formats/hotel-software-or-pms-demo-checklist-reservation-functions/)
- [Hotel Software or PMS Demo Checklist – Cashiering and End of Day Functions](https://setupmyhotel.com/?p=2981)
- [Housekeeping Functionalities Checklist for Reviewing Hotel Software or PMS](https://setupmyhotel.com/hotel-formats/housekeeping-formats/housekeeping-functionalities-checklist-for-reviewing-hotel-software-or-pms/)
- [Oracle OPERA – Routing Transactions](https://synxis-dtmd.dusit.com/OperaHelp/routing_transactions.htm) and [Routing limits](https://docs.oracle.com/cd/E98457_01/opera_5_6_core_help/routing_limits.htm)
- [Hotel Property Management Systems: Products and Features (AltexSoft)](https://www.altexsoft.com/blog/travel/hotel-property-management-systems-products-and-features/)
- [Airbnb – FRRO Form C guidance for hosts in India](https://www.airbnb.co.in/help/article/1641)
- [BW Hotelier – C-Form automation for hotels](https://bwhotelier.com/article/as-part-of-govt-compliance-ecobillz-offers-c-form-automation-solution-for-hotels-to-manage-foreign-guests-458690)
- [RoomBoss – Rate setup (derived rates)](https://docs.roomboss.com/pms/rates/setup) and [WebRezPro – Rate management](https://webrezpro.com/rate-management/)
- [Clock PMS+ – Rate and revenue management](https://www.clock-software.com/products/pms/rate-and-total-revenue-management)
- [Xotels – Pickup report](https://xotels.com/en/revenue-management/revenue-management-book/pickup-report) and [Canary – Must-have hotel reports](https://secure.canarytechnologies.com/post/must-have-hotel-reports)
- [Oracle OPERA Cloud – Commission codes](https://docs.oracle.com/en/industries/hospitality/opera-cloud/23.4/ocsuh/c_configuration_codes_commission_codes.htm) and [SetupMyHotel – Market segment codes](https://setupmyhotel.com/formats/fo/102-market-codes.html)
- [AxisRooms – Hotel GST billing checklist](https://www.axisrooms.com/wp-content/uploads/2026/06/Hotel_GST_Billing_Checklist_Sample_by_AxisRooms-1.pdf) and [Busy – SAC 996311](https://busy.in/sac-code-996311/)
- [Taxmann – GST on hotel accommodation](https://taxmann.com/post/blog/analysis-gst-on-hotel-accomodation-services) and [AxisRooms – Hotel GST 2025](https://blog.axisrooms.com/hotel-gst/)
- [Grant Thornton – credit-note time limit extended to 30 November](https://grantthornton.in/link/25294f9523a04265a1007a9423f20149.aspx) and [Tally – Credit notes under GST](https://tallysolutions.com/gst/credit-note-under-gst/)
