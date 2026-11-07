# BluInn module interconnection audit — 7 November 2026

Findings only. No bugs were fixed in this pass.

Paths are relative to the `bluinn` repo. `M/` means `neon/migrations/`, `P/` means `app/(bluinn)/(protected)/`.

## How this was checked

- **Code review in parallel**, one reviewer each for Front Office, Operations, Commercial, and People & Admin. Each re-checked every finding from the 6 Nov audit against the current code, including the uncommitted fixes in `0039_interconnection_fixes.sql`, and looked for new gaps.
- **Cross-module flows run for real** against a throwaway local Postgres with all 39 migrations applied. Eight lifecycles were run end to end:
  1. Reservation through to reports
  2. Cancellation and no-show
  3. Room move and stay split
  4. Maintenance block
  5. Events
  6. Groups
  7. HR timesheets
  8. Multi-property

  Where logic lives in TypeScript, the actions' inserts were replayed step by step.
- **The hosted Neon database was not touched**, apart from one read-only row count. It is nearly empty:
  - 1 property, 1 staff user, 2 room types and **0 rooms**
  - 1 booking and 1 guest
  - the masters created by the migrations (roles, departments, templates, outlets)

Each finding is marked **SQL** (reproduced on the local database) or **code** (from reading the code).

## Where the 6 Nov findings stand

| | Count | Examples |
|---|---|---|
| **Fixed** | 10 | Invoiced-folio guard, merge guests, failed check-in payment, GST on fees and penalties, double stock deduction, cleaning task after maintenance, check-out issues invoices, folio and event refund caps, loyalty earned at check-out |
| **Partly fixed** | 10 | Closed-day lock (event payments and undated lines), gateway refund retry, dashboard KPIs, tax summary vs GSTR-1 basis, on-hand stock check (automatic consumption still goes negative), "total revenue" definition, allowance plus credit note, stale screens |
| **Still open** | about 115 | Everything else, listed under each heading below |

The 7 Nov fixes introduced **five regressions**. All are about check-out auto-invoicing and the new invoiced-folio guard, and they lead the "fix first" list.

---

## Fix these first

| # | Severity | Gap | Where | Proof |
|---|---|---|---|---|
| 1 | **High · regression** | **Check-out is not atomic, so a retry posts the late fee (and payment) again.** Late fee, then payment, then invoice are separate writes. If the invoice step refuses (no hotel GSTIN, B2C bill of ₹50k or more with no address, bad buyer GSTIN), the guest is not checked out but the fee and payment stay. Every retry adds another fee. The form also pre-fills the payment as the balance *before* the late fee, so a late check-out fails "still owed" by default and pushes the desk into a retry. | `frontdesk-actions.ts:404-476`, `check-out/page.tsx:70,140` | SQL |
| 2 | **High · regression** | **With no hotel GSTIN, nobody who can invoice can check a guest out.** Properties default to `tax_regime='gst'` and `gstin=''`. `front_desk`, `front_office_manager` and `manager` all hold `folio.invoice`, so a fresh install cannot check anyone out. The hosted property is in this state. | `gst.ts:240-243`, `frontdesk-actions.ts:475` | SQL + code |
| 3 | **High · regression** | **Outlet and event postings fail once the stay is invoiced.** `pos_charge_to_room` adds an "already paid at the outlet" credit to the invoiced master folio, and the event deposit credit does the same. The 0039 guard refuses both with `FOLIO_INVOICED`. Part-paid restaurant bills, minibar and laundry charges, and events with a deposit cannot be charged to the room after an interim or check-out invoice. | `M/0032:442-446`, `M/0019` (deposit credit), `M/0039:70-77` | SQL |
| 4 | Medium · regression | **One folio can get two issued invoices.** 0039 added a *non-unique* index. A double-clicked check-out, or "Issue invoice" plus check-out at the same moment, gives duplicate GSTR-1 rows and double loyalty points. After that, `.maybeSingle()` errors and a third invoice can follow. | `M/0039:26`, `invoice-issue.ts:656-662,960-966` | SQL |
| 5 | Medium · regression | **After check-out, the master folio refuses allowances and voids, but the buttons still show.** Front-desk and FO-manager roles have no `folio.credit_note`, so they hit `FOLIO_INVOICED` with no way forward except cancelling the invoice. Charges posted after check-out (late minibar) go to the "After invoice" folio, which nothing ever invoices. | `FolioPanel.tsx`, `booking-actions.ts:1062,1090`, `M/0039:36-52` | SQL |
| 6 | **High** | **Night audit books every un-closed room line onto the audit day.** `close_folio_day` stamps all open lines, whatever night they were for. On 11-07 room revenue read ₹26,821, but the true night was ₹8,050. ADR read ₹13,410 instead of ₹4,025. This feeds night audit, the daily report, dashboard tiles and the flash report. | `night-audit-actions.ts:174-189,313` | SQL |
| 7 | **High** | **Nights past the due-out date are never charged.** An overstay due out 11-06 and still in house on 11-07 had 1 of 3 nights charged. Night audit only lists it under exceptions. | `night-audit-actions.ts:104`, `frontdesk-actions.ts:381-389` | SQL |
| 8 | **High** | **Cancellation and no-show penalties are never invoiced,** so their GST is in the tax summary, flash and night audit but never in GSTR-1. | `booking-actions.ts:503-527`, `night-audit-actions.ts:136-146` | SQL |
| 9 | **High** | **A room upgrade oversells the new type.** The move updates only `room_id`, not the room type. In the test, luxury capacity still showed 2 with only 1 luxury room free, and a 2-room luxury booking was accepted. | `booking-actions.ts:829-836` | SQL |
| 10 | **High** | **Splitting an in-house stay by date breaks it.** Part 1's check-out dirties the room while the guest is still in it. Part 2 is "confirmed" in a dirty room, can't be checked in, and night audit can mark it a no-show. | `booking-actions.ts:880-918` | SQL |
| 11 | **High** | **Event money doesn't reach the cashier or reports, and a cancelled event keeps its folio charge.** After a ₹5,000 cash event deposit, expected cash in the drawer was unchanged and the payments report didn't move. After `event_cancel`, a ₹38,500 + ₹6,930 GST line stayed on the guest's folio. | `M/0019` `event_take_payment`, `event_cancel` | SQL |
| 12 | **High** | **Removing "all properties" access doesn't remove the hotel the person is in.** `current_property()` trusts `active_property_id` without re-checking access. The person keeps reading and writing that hotel's rooms and bookings, and their property switcher shows nothing. | `M/0024:117-124`, `actions.ts:195` | SQL |
| 13 | **High** | **"Remove staff" fails for anyone who has ever worked a cash shift or posted to a folio.** The delete hits `cashier_shifts` (RESTRICT) and `FOLIO_IMMUTABLE`, and the screen shows the raw error. Where the delete does go through, it still cascades away attendance, leave and timesheets. | `actions.ts:112-113`, `M/0001:16` | SQL |

---

## 1. Broken links and routing

**/billing has no page.** Only `billing/layout.tsx` exists, so the URL returns a 404. The sidebar links to `/billing/invoices` instead. `P/billing/`

**The sidebar or tabs show links that the page then refuses** (the user is sent to the dashboard with "access denied"):

| Link or tab | Shown to holders of | Page requires | Where |
|---|---|---|---|
| Billing (nav) | `reports.financial`, `folio.refund_approve`, `folio.credit_note` | `folio.view` / `folio.invoice`. The seeded **F&B manager** hits this. | `nav.ts:130` vs `billing/invoices/page.tsx:31` |
| Billing tabs: Invoices, Refunds, Currencies | everyone the Billing layout admits | each page's own permission | `billing/layout.tsx:9-23` |
| Events (nav), Events and Diary tabs | `events.quote/approve/bill/manage` | `events.view` / `events.book` | `nav.ts:109` vs `events/page.tsx:73` |
| Reports (nav) | `reports.schedule` | `reports.view` / `reports.financial` | `nav.ts:136` vs `reports/page.tsx:34` |
| Reports tabs: Operations, Guests | `reports.financial` only | `reports.view` | `reports/layout.tsx:16-17` |
| POS till and order pages | `pos.manage` | a till permission (`pos.order`, etc.) | `nav.ts:103` vs `pos/[outletId]/page.tsx:34` |
| Ticket → Asset link | anyone on the ticket (e.g. `maintenance.report`) | `maintenance.work` / `maintenance.manage` | `maintenance/[id]/page.tsx:140` |
| Ticket → View booking | maintenance staff | `bookings.view` | `maintenance/[id]/page.tsx:125` |
| Housekeeping Setup → Staff, Settings, Rates | housekeeping supervisor | `staff.manage`, `settings.manage`, `rates.view` | `housekeeping/setup/page.tsx:41,161,166` |
| Data export → back to Settings | `data.export` | `settings.manage` | `settings/export/page.tsx:23` |
| Event invoice → credit note | banquet manager | folio or financial permission | `events/[id]/invoice/[invoiceId]/page.tsx:128` |
| Dashboard "N open guest requests" alert | `frontdesk.requests` (e.g. HK supervisor) | `frontdesk.view` | `P/page.tsx:200-202` |
| Packages editor | under `/revenue` (`revenue.*`) | editing needs `rates.manage` | `revenue/packages/page.tsx:31-33` |
| Feedback form on staff profile | `frontdesk.requests` | `hr.view` / `hr.manage` to open the page | `hr/staff/[id]/page.tsx:18,195` |

**The property switcher lists closed hotels** and lets staff switch into them. `lib/properties.ts:31`, `M/0024:184`

**Penalty-failure messages say "post it from the folio",** but the folio can only post `extra` or `fee` lines, not penalties. `booking-actions.ts:473,493` vs `:1041`

**Stale screens.** `/bookings/[id]/folio` is never revalidated after POS or event charges. Minibar and laundry posting revalidates no booking page. The POS till page now polls every 15 seconds, which is fixed. `pos-actions.ts:366`, `event-actions.ts:520`, `housekeeping-actions.ts:377`

## 2. Data that doesn't flow between modules

### Rooms, housekeeping and maintenance
- **Room blocks and tickets don't update each other.** Releasing a block on the Rooms page leaves its maintenance ticket open, and reopening a resolved ticket doesn't re-block the room. **SQL.** `rooms-actions.ts:163-182`, `maintenance-actions.ts:232-243`
- **A room can't be put out of order today if any future booking is assigned to it** (`ROOM_IN_USE` for a booking 3 days out). The check should only refuse when nights overlap. **SQL.** `M/0032 mt_block_room`
- **Putting a room out of order leaves its open cleaning task on the board.** **SQL.** `room-blocks.ts:28-38`
- **Lost & found can't be linked or closed.** The `booking_id`, category, storage location and returned/disposed columns exist, but the only action is "add". `housekeeping-actions.ts:223-247`
- **Housekeeping tasks can never be cancelled.** The status exists, but nothing sets it. `M/0009:92`
- **Daily stay-over cleaning is off by default.** `M/0032:32`
- **Maintenance doesn't record spare parts against inventory.** `maintenance-actions.ts`
- **Events never hold rooms.** There is no link from events to groups, blocks or allotments. `M/0019`

### Folio, POS and events
- **Outlet payments point at the wrong folio.** `pos_payments.folio_id` and `event_payments.folio_id` still name the invoiced master folio after the lines were moved to "After invoice". **SQL.** `M/0032:448-450`
- **POS charges can cross into another hotel.** `pos_charge_to_room` accepts a booking from another property: a DL restaurant bill landed on an H1 folio under H1's GSTIN, while the stock stayed in DL. **SQL.** `M/0032 pos_charge_to_room`. `event_post_to_folio` looks the same but was not tested.
- **Voiding a room charge on the folio, or issuing a credit note, leaves the POS bill settled,** so it still counts in outlet sales and the room-charge limit. `pos-actions.ts:408-413`
- **Events can be billed to a guest who has checked out.** The event lands on a new "After invoice" folio of a closed stay. **SQL.** `M/0019 event_post_to_folio`
- **An event already charged to a folio can still be invoiced on its own,** because `issueEventInvoice` checks only for an earlier event invoice. **SQL** (tax bands). `event-actions.ts:529-558`
- **An event fully paid by deposit can never be invoiced,** because the invoice form needs a balance above ₹0. `events/[id]/page.tsx:736`
- **Confirmed events that aren't invoiced are missing from GST returns.** Their tax shows in the tax summary but not in the GST register. **SQL**
- **A cash refund lands on the approving manager's cash shift,** and fails if the manager has no open shift. `billing-actions.ts:441-452`
- **Foreign-currency cash is counted as rupees in the drawer.** `currency-actions.ts:60-73`
- **Package contents and meal plans are booked entirely as room revenue.** `folio.ts:61`, `revenue.ts:237`
- **Editing a booking drops its promo discount,** while the redemption row keeps the old discount. `booking-actions.ts:627-701`
- **An early departure keeps the original booking total.** `frontdesk-actions.ts:482-491`
- **Check-out doesn't pre-fill the bill-to address or GSTIN.** The folio tab does pre-fill them, so repeat corporate guests get a B2C invoice at check-out. `check-out/page.tsx:168`

### Stock
- **Automatic consumption has no on-hand check.** Selling 99 Colas left stock at −82, and the test seed already shows Shampoo at −2. Only manual moves are checked. **SQL.** `M/0039:372-462` vs `:503-510`
- **A bill that was settled, reopened and then voided never gives its stock back.** **SQL.** `M/0039:376-378`
- **Minibar restock is missed or double-counted.** A quantity typed without ticking the box is ignored. An item linked to both a POS item and a checklist line is deducted twice. `housekeeping-actions.ts:148`
- **Inventory can be linked to another hotel's records.** An item or location can be tied to another property's POS item, outlet or checklist line. `inventory-actions.ts:73-74,107`
- **Saving a housekeeping default location clears the flag at every hotel.** `inventory-actions.ts:99`

### Guests, loyalty and notifications
- **Loyalty points are never reversed.** Cancelling and re-issuing an invoice earned 40 → 80 points. A full credit note left all 511 points in place. **SQL.** `M/0016:251,298`
- **Points at check-out depend on who checks the guest out.** They are earned only when the user holds `folio.invoice`; otherwise there is just a warning. `frontdesk-actions.ts:483-495`
- **A guest's profile misses stays where they were a sharer,** so stay history and stats leave those out. `guests/[id]/page.tsx:95-99`
- **Merging into an erased guest copies personal data back.** `merge_guests` doesn't check `erased_at`. `M/0039:172-248`
- **Re-running the notifications job re-sends to guests.** It sends before recording and ignores insert errors. `notifications.ts:243-293`
- **The notification and report crons ignore multi-property.** They use the default hotel's settings and templates for every hotel. `cron/notifications/route.ts:63`, `cron/reports/route.ts:29`
- **Currencies are global.** One hotel's settings manager changes exchange rates for every hotel. **SQL.** `currency-actions.ts:104-117`

### Rates and revenue
- **Channel allocations are saved but never enforced,** although the page says they are. `rates/allocations/page.tsx:31`
- **Pricing rules only run when someone clicks.** There is no cron, and turning every rule off leaves the old dynamic rates live. `revenue-actions.ts:184-186`

### People
- **Biometric punches are always filed at the default hotel,** in its timezone. `M/0012:226-248`
- **Self clock-in, leave and timesheets are filed at the hotel the person is viewing,** not their home hotel. `M/0012:198`, `M/0038:413-431`
- **Roster auto-fill and "copy last week" ignore approved leave,** and copy shifts of deactivated staff. `hr-actions.ts:339-389`
- **A payroll export by someone with `hr.export` but not `hr.view` shows 0 shifts and 0 absences,** because the RLS on `staff_shifts` differs from the other HR tables. `M/0012:348-357`
- **`staff_properties` is never written,** so no screen lets someone work at several hotels without `all_properties`. `M/0024:91`
- **Moving staff between hotels errors out.** **SQL.** `actions.ts:194,198`, `M/0024:500`

## 3. Missing validations

**Folio and bookings**
- **Charges and payments are accepted on cancelled or checked-out bookings.** A ₹500 extra was accepted on a cancelled booking. **SQL.** `booking-actions.ts:988,1027`
- **Nothing locks two simultaneous check-outs,** so both can take a settlement payment. `frontdesk-actions.ts:369-431`
- **A failed check-in can be double-posted on retry.** If the status update fails, the payment and early fee stay posted and a retry posts them again. `frontdesk-actions.ts:325-336`
- **A failed no-show penalty is never posted.** Night audit sets the no-show status first; if the penalty insert fails, the booking leaves the "due" list and the penalty is never retried. Cancellation has the same order. `night-audit-actions.ts:123-146`, `booking-actions.ts:503-584`
- **Undated lines get through the closed-day lock.** Payments, penalties and paid-outs have no stay date and land on whatever day the next audit stamps them. `M/0039:116-130`
- **Amending a booking allows a check-out before nights already charged, or a past arrival.** `booking-actions.ts:605-610`
- **The check-in deposit check counts allowances as payments and ignores refunds.** `frontdesk-actions.ts:198`, `policies.ts:137`
- **Check-out is blocked outright when a folio's allowances exceed its charges.** `invoice-issue.ts:1009`
- **The refund cap counts money paid, not money owed back.** After a ₹1,180 credit note, ₹11,918 still counted as refundable. **SQL.** `M/0039:236`
- **Credit notes can exceed the invoice value.** The cap ignores negative allowance lines: an invoice of ₹800 net was credited ₹1,000. **SQL.** `M/0036 credit_note_issue`
- **Feedback isn't checked against the booking's guest.** `guest-actions.ts:97-102`

**Groups**
- **Groups can be created for past dates.** `group-actions.ts:40`
- **Rooms added to a group later get no hold expiry and hold stock forever.** **SQL.** `group-actions.ts:187-206`

**POS**
- **A settled bill's tip and room can still be changed.** A settled bill went from ₹1,155 to ₹1,655 and stayed "settled" with ₹500 owing, and charge-to-room then accepts that balance. **SQL.** `pos-actions.ts:116-136`, `M/0032:357-364`
- **Two tills can pay the same bill.** Payment, points redemption and charge-to-room have no row lock. `M/0017:645`
- **Voiding a line on a part-paid bill can leave it stuck at "billed".** `M/0032:562-566`
- **The room-charge limit counts every charge ever made,** not just unpaid ones. `M/0032:388-396`
- **Negative modifier prices are accepted.** `pos-actions.ts:552`

**Events**
- **An approved quotation can be repriced (up to a 100% discount) without re-approval.** `event-actions.ts:181-244`
- **Inactive venues and layouts from another venue are accepted.** `event-actions.ts:109-139`

**Rates**
- **A plan adjustment of −150% gives free stays,** and ₹0 rates are accepted. `rates-actions.ts:276`, `pricing.ts:162`
- **Seasons can overlap without warning.** `rates-actions.ts:310-345`
- **Promo limits aren't safe when two bookings use the last code at once.** `M/0020:338-396`

**HR**
- **The database trusts whatever timesheet hours the caller sends.** A direct RPC call submitted and approved 40 regular plus 500 overtime hours against 9 hours actually worked, and that figure goes into the export. **SQL.** `M/0038 timesheet_submit`, `timesheet_decide`
- **Approving a week strands night-shift workers.** Someone clocked in on Sunday night can't clock out (`TIMESHEET_LOCKED`) or clock back in (`ALREADY_IN`). **SQL.** `M/0038:281-302`
- **Seeded approvers can approve a week but can't reopen it.** Reopening needs `hr.manage`, while approving needs `hr.approve_time`. `hr-actions.ts:215`
- **Manual attendance accepts a future clock-out, overlapping records, and out = in (counted as 24 h).** `hr-actions.ts:408-409`
- **Approved leave can't be withdrawn, and leave can be booked on days already worked.** `hr-actions.ts:111-145`
- **Saving the roster wipes cells that use a deactivated shift type.** `hr/roster/page.tsx:94-100`
- **Roster fill and copy accept any start date,** not only a Monday. `hr-actions.ts:342,372`
- **A required geofence also blocks clock-out off site.** `M/0012:215`

**Reports**
- **A user with `reports.schedule` but not `reports.financial` can email revenue reports to any address,** because the cron runs as the service role. "Send now" fails for that same user. `report-actions.ts:45-50,108`

## 4. Dead buttons and silent failures

- **"Offer on the website" toggles on rate plans and promo codes do nothing.** The guest site was removed. `rates/plans/page.tsx:217`
- **Choosing a report schedule to edit doesn't load its fields,** so saving overwrites it with blanks. `reports/schedules/page.tsx:141-178`
- **The flash report can't be scheduled.** `report-actions.ts:20-27`
- **"Corporate" is still offered as an allocation channel.** `rates-actions.ts:24`
- **Saving a property with only `properties.manage` says "Saved." but writes nothing.** **SQL.** `property-actions.ts:71-83`
- **Night audit says it closes cash shifts, but it doesn't.** `night-audit-actions.ts:25`
- **Resolving or cancelling a ticket ignores a failed room release,** so the ticket closes while the room stays out of order. `maintenance-actions.ts:218,257`
- **Housekeeping room-status writes discard errors,** so a task can show cleaned while the room stays dirty. `housekeeping-actions.ts:48-53,83,88`
- **Picking "inspected" without `housekeeping.inspect` does nothing and shows no message.** `rooms-actions.ts:101-119`
- **Voiding a POS payment drops the error from reopening the bill.** `pos-actions.ts:425`
- **A check-out can fail after the invoice is issued,** leaving the guest in house with an issued invoice. `frontdesk-actions.ts:473-492`
- **Errors are thrown away in many other places.** The screen reports success, or says nothing, even when the database refused the change:

  | Where | Actions |
  |---|---|
  | `maintenance-actions.ts:232-306,401-407` | reopen ticket, assign ticket, set ticket priority, delete schedule |
  | `housekeeping-actions.ts:95-106,277-296,382-390` | reassign task, set staff duty, delete zone, set laundry status |
  | `hr-actions.ts:138,332,432,460` | cancel leave, roster save (clearing cells), delete attendance (a locked week fails silently), delete department |
  | `template-actions.ts:58` | reset template |
  | `actions.ts:133,152` | password reset's "must change" flag, removing an authenticator |
  | `rates-actions.ts:438` | delete allocation |
  | `billing-actions.ts:295` | cancel payment request |
  | `booking-actions.ts:841` | room-move record |
  | `frontdesk-actions.ts:222-258` | check-in documents and guest update |
  | `night-audit-actions.ts:222` | per-room status |

- **HR profile saves report success without saving** when the staff member or department belongs to another hotel. `M/0038:58-80`
- **Deleting a role counts only the current hotel's staff,** then fails with a raw foreign-key error. `actions.ts:272-279`
- **Leftover unused columns:** `booking_notes`, the guest feedback token, guest-portal columns, and the city-ledger paths. This matches the decision to keep corporate out.

## 5. Orphan pages

**None.** All 98 `page.tsx` files have an inbound link, tab or redirect. Some are reachable only by typing the URL for certain roles:

- `/night-audit/[date]` for `folio.view`-only users, such as the POS cashier
- `/front-desk/shifts` for `reports.financial`-only users
- `/events/[id]` for `events.bill`-only users

## 6. Inconsistent numbers

Measured on the local database for one day (11-07, one hotel) after the flow 1 run:

| Metric | Dashboard | Reports overview | Flash | Night audit | GST register |
|---|---|---|---|---|---|
| Room revenue | 26,821 | 26,821 | 26,821 *and* 16,354 ("Rooms" dept) on the same page | 26,821 | room line 8,050 |
| Tax | 5,752.50 | 5,752.50 | 4,411.96 | 5,752.50 | 3,257.32 (month, net of CN) |
| Total revenue | 93,300 net | 99,052 incl. tax | 69,079 net of CN | 99,052 incl. tax | — |
| Credit notes | not netted | not netted | 5,380 netted | not netted | netted |
| ADR | 13,410 | 13,410 | same basis | 13,410 | true value ≈ 4,025 |
| Occupancy | live tile 50%, KPI tile 25% | 25% | 2/8 | 2/8 | — |

For November, the tax summary shows ₹30,055 against ₹3,257 in the GST register. The gap is uninvoiced penalties, events and post-check-out charges, plus stay-date vs issue-date timing.

Other definitions that differ:

| Metric | How it differs |
|---|---|
| **Room revenue / ADR** | Every un-closed room line is stamped onto the audit day (fix-first #6). The flash "Rooms" row is department-based (includes fees and penalties, net of allowances and credit notes). |
| **Total revenue** | Now net of tax everywhere, which is fixed. Dashboard and overview still exclude outlet-paid bills and events, include paid-outs, and don't net allowances or credit notes. The flash report does the opposite. |
| **Daily report dating** | `report_daily` dates other revenue by the day it was created, but tax and total by stay date, so Revenue ≠ Room + Other. **SQL.** `M/0031` |
| **Paid-outs** | Counted as revenue in the daily report and night audit, excluded in flash and the tax summary. As invoice lines they go into GSTR-1 as 0% supplies with SAC "—" and earn loyalty points. |
| **Tips** | Counted as F&B when charged to a room (and as a 0% invoice line), excluded when settled at the outlet. |
| **Night-audit outlet takings** | Room-charged POS bills are counted twice. `night-audit-actions.ts:270-295` |
| **Occupancy** | The dashboard excludes out-of-order rooms; night audit excludes only out-of-service. Night audit counts "available" *after* applying tomorrow's blocks. |
| **Arrivals and departures** | Four definitions: dashboard (still due), front desk (incl. late), night audit (checked in only), flash (checked in plus checked out). |
| **Business vs calendar date** | No-shows and night audit use the business date. Check-in/out fees, housekeeping, invoices and the dashboard chart use the calendar date. KPI tiles read business date − 1, but the 30-day chart is anchored to today. |
| **GST** | Tax summary: stay date, CGST/SGST only. GST register: issue date. |
| **Invoice page totals** | Don't net credit notes, and read every invoice without paging, so they undercount past about 1,000 a year (PostgREST cap). `billing/invoices/page.tsx:44` |
| **Event balance** | The page ignores credit notes but the database counts them, so the page offers a payment the database rejects. `lib/events.ts:200` |
| **Penalty previews** | Show the net amount; the folio posts net plus GST. `bookings/[id]/page.tsx:186-191` |
| **"Paid" at check-out** | Includes allowances. |
| **Stock** | Negative on-hand from automatic consumption. |
| **POS "settled today"** | Selected by when the bill was opened, capped at 200 bills. Reports select by when it was closed. |
| **Staff counts and hours** | Inactive staff are on some screens and not others. Hours round to 1 decimal in one place and 2 in another. "Tasks done" depends on the viewer's permissions. |
| **Password rules** | Length and expiry come from the hotel being viewed; lockout limits come from the default hotel. |

## 7. Security (deferred pass, listed for completeness)

- **2FA can be enrolled or removed by an unverified session.** Enrol and remove use `getSession()`, so a password-only or revoked session can do it. There is no limit on code guesses, and removing 2FA isn't logged. `security-actions.ts:112-182`
- **The data export and audit export skip the stronger session checks** (revoked or pre-2FA sessions still work). `settings/export/download/route.ts:18`, `audit/export/route.ts:18`
- **A `staff.manage` holder can take over the owner's account.** They can delete, reset the password or reset 2FA on any account through the service role, with no property or superuser check, and can grant superuser. These actions are logged as "System". `actions.ts:105-166`
- **Removing `all_properties` leaves live access to the active hotel** (fix-first #12).
- **Changing your own password can be used to guess passwords.** It checks the current password through an untracked sign-in, so guesses are never throttled. `security-actions.ts:205-210`
- **The Security events page shows every hotel's sign-ins to a hotel-level auditor.** `audit/security/page.tsx:50-59`
- **The server session lasts 7 days;** the idle timeout is only enforced in the browser. `dashboard.view` is never enforced. Clock-in coordinates can be spoofed.
- **Changes to promos and pricing have no audit trigger.**
- **The Razorpay webhook can credit a folio twice.** Its duplicate check isn't atomic. A gateway refund that fails to post can't be retried.

## 8. Integrations pending (by your decision)

Razorpay payment links and webhook, real TOTP 2FA (currently `TWO_FACTOR_MODE=demo`), SMS (Twilio), email (Resend), door locks, KOT display, biometric devices, and GST e-invoicing (IRN). Without these, each send or attempt is logged as "not configured". Nothing above depends on them, except the Razorpay notes in section 7.

## 9. Found while loading demo data and checking it live

The demo data is in `neon/demo/` and was loaded into the hosted database on 7 Nov. I then signed in as the admin and opened 67 pages, viewing only. Every page loaded (HTTP 200), showed data, and logged no server errors.

- **Company-billed invoices earn loyalty points.** Folio invoices are saved without `company_id`, so the company check in `loyalty_award_for_invoice` never fires and the guest earns points on company-billed stays. `app/lib/invoice-issue.ts:107`
- **Night audit counts out-of-order rooms as available.** The `sellable` count excludes only out-of-service rooms, which skews occupancy and RevPAR. It disagrees with `room_type_capacity`. `night-audit-actions.ts:233`
- **Same-day room turnover leaves the room marked available.** When one guest leaves and the next checks in on the same day, the room status can stay "available", which suggests a check-out/check-in ordering issue. The demo data needed a one-line fix after loading, so this should be confirmed in the app.
- **Some pages are slow.** In local dev against the hosted database, the flash report took about 44 s to load and the dashboard about 10 s. It needs measuring on the deployed app.
- **Flash report "last year" shows 0** while the year-to-date columns are built from about 4 weeks of data. This is expected with demo data, but there is no label saying no comparison data exists.

## What is correctly wired

- **Room cycle:** check-in occupies the room, check-out dirties it and creates a task, and clean → inspect makes it sellable. A room back from a block or maintenance now gets a touch-up task (0039).
- **Blocks:** they reduce capacity on every date. A room with a guest can't be blocked, and a blocked room can't be assigned.
- **Folio and invoice:** after the 0039 guard, the invoice matched the folio exactly (net ₹10,230, tax ₹1,688, CGST = SGST). Expected cash in the drawer was correct (₹11,600). Minibar stock was deducted once.
- **Refund caps** apply to folios, refund requests and events, under row locks.
- **Fees and penalties** are taxed at the room's slab in all five places.
- **Credit notes** are numbered on their own series and kept out of the allowance totals. The GST register is built from frozen invoice and credit-note rows. Invoice numbers are claimed atomically, per property.
- **Promo redemptions** follow the booking and are released on cancel or no-show.
- **Multi-property reporting:** daily, flash, tax summary, payments, invoices, rooms and cash shifts are all scoped correctly, with no leaks between hotels.
- **Timesheet approval** recomputes figures from attendance on the server, refuses your own week, and locks attendance.
- **Navigation:** no redirect loops. Every permission key used in SQL exists in `permissions.ts`.
