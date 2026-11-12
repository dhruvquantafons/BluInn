# BluInn module interconnection audit — 12 November 2026

Where BluInn's modules stand on 12 November 2026:
- What the 7 November audit found, and what has been fixed since.
- The decisions taken on 12 November.
- Every gap that is still open.

This report replaces the 7 November version, which is in git history (commit `e9ae199`).

Paths are relative to the `bluinn` repo. `M/` means `neon/migrations/`, `P/` means `app/(bluinn)/(protected)/`. Open findings name the file (and the function where useful). Line numbers are left out, because the files changed a great deal this week.

## Summary

The 7 November audit found that the modules were mostly well connected at the database level but broken in the money chain (folio → invoice → GST), in stock, and around room moves, events and staff. Four migrations since then have fixed the gaps in sections 1–4:

| Migration | What it fixed |
|---|---|
| `0040_fix_first.sql` | All 13 "fix these first" items, including the five regressions from the 7 November fixes |
| `0041_data_flow.sql` | 34 of the 41 "data that doesn't flow" items |
| `0042_event_rooms_and_till_stock.sql` | Event room blocks and tills stopping at zero stock (your 12 November decisions) |
| `0043_validations_and_links.sql` | Broken links, missing validations and dead buttons (sections 1, 3 and 4), with the app changes that go with them |

All four are applied to the hosted Neon database. **The app code that goes with them is not yet committed or deployed**; see [Deployment](#deployment).

| Area | Found 7 Nov | Status 12 Nov |
|---|---|---|
| Fix these first | 13 | **All fixed** (0040) |
| 1. Broken links and routing | 18 | **Fixed** (0043 and app) |
| 2. Data that doesn't flow between modules | 41 | **37 fixed** (34 by 0041, 2 by 0040, 1 by 0042); 4 not fixed, by decision |
| 3. Missing validations | 32 | **Fixed** (0043 and app) |
| 4. Dead buttons and silent failures | 14 (plus 10 places that discard errors) | **Fixed**; one toggle relabelled instead of removed (see below) |
| 5. Orphan pages | 0 | None |
| 6. Inconsistent numbers | 19 definitions | 2 fixed, 2 partly fixed, 15 open |
| 7. Security (deferred pass) | 9 | 1 fixed (0040); 8 deferred |
| 8. Integrations | — | Pending, by your decision |
| 9. Found while loading demo data | 5 | 1 fixed (0040); 4 open |

Four more problems turned up while fixing and are fixed too (see [Also found and fixed](#also-found-and-fixed)).

## How this was checked

**The 7 November audit:**
- **Code review in parallel**, one reviewer each for Front Office, Operations, Commercial, and People & Admin.
- **Eight cross-module lifecycles run end to end** on a throwaway local Postgres:
  1. Reservation through to reports
  2. Cancellation and no-show
  3. Room move and stay split
  4. Maintenance block
  5. Events
  6. Groups
  7. HR timesheets
  8. Multi-property
- **A read-only page check** of 67 pages on the hosted app.

**The fixes, 7–12 November** (0040–0042; 0043 is described under [Links, validations and dead buttons](#links-validations-and-dead-buttons-0043)):
- **Database checks:** every fix has an assertion in the local database tests, run against all 42 migrations. There are 36 new checks (10 for 0040, 18 for 0041, 8 for 0042). Each failed before its fix and passes after it, and the existing behaviour tests are otherwise unchanged.
- **Unit tests:** 430 pass. The type check and lint are clean.
- **In the app:** the main fixes were exercised against a local copy of the demo database.
- **Rehearsal:** each migration was applied to a local copy of the demo data before it was applied on Neon.

## Decisions, 12 November

| Question | Decision |
|---|---|
| Events holding guest rooms | **Built** (0042), [described below](#event-room-blocks) |
| Spare parts recorded against inventory | Not now |
| Blocking sales when stock runs out | **Built** (0042) for outlet tills only. A till can't sell more of a stock-tracked item than the outlet holds, less what open bills already have. The till shows "n left" and "Sold out". Minibar items found used in a room, and cleaning amenities, are never refused. |
| Night auditor issuing invoices | No. No-show penalties the night auditor posts are listed on the audit report for someone else to invoice. |
| Stay-over cleaning for the existing hotel | Left off. New hotels get it on. |
| Overstay nights | Charged at the guest's last nightly rate |
| Nightly jobs | Four separate jobs. Merge them into one endpoint only if Vercel refuses the deploy. |
| Committing and pushing | Done by you |

Earlier decisions that still stand:
- **Declined 5 November:** corporate accounts and the city ledger, channel-allocation enforcement, priced meal plans, travel agents, the rate calendar, and a channel manager.
- **Deferred:** the security pass.
- **Declined 6 November:** payroll and leave balances.

## What was fixed

### Fix these first (0040)

| # | Was | Now |
|---|---|---|
| 1 | A refused check-out left the late fee and payment posted; each retry added more | Everything that can refuse is checked before anything posts; the late fee is never charged twice |
| 2 | With no hotel GSTIN, nobody who can invoice could check a guest out | The guest checks out with a warning; invoice from the folio once the GSTIN is set |
| 3 | Part-paid outlet bills, minibar and event deposits failed once a stay was invoiced | They post to the "After invoice" folio, payment record included |
| 4 | One folio could get two invoices | One issued invoice per folio, enforced by the database |
| 5 | Void and allowance buttons appeared on invoiced lines and then failed | Invoiced lines say "Invoiced" and point to a credit note; a closed stay with uninvoiced charges shows a warning |
| 6 | Night audit put later nights' lines on today's revenue, inflating ADR | Only the day's own lines are closed |
| 7 | Overstay nights were never charged | Night audit extends the stay and charges the night; check-out charges any it missed |
| 8 | Penalties never reached the GST return | Cancellation and no-show penalties are invoiced |
| 9 | An upgrade oversold the new room type | The booking takes the new room's type and capacity is checked; the move list offers other types |
| 10 | Splitting an in-house stay left part 2 stuck | Part 1's check-out checks part 2 into the same room, which isn't sent for cleaning |
| 11 | Event money was missing from cash shifts and payments; a cancelled event stayed on the folio | Both fixed |
| 12 | Losing all-hotels access left access to the current hotel | It now does not |
| 13 | "Remove staff" failed for anyone with history | They are suspended; their records keep their name |

### Data that now flows (0041)

**Rooms, housekeeping and maintenance**
- **Blocking a room:** an urgent fault can block a room even when a later booking is assigned to it. That booking loses the room so the desk can reassign it; only a guest in the room stops the block.
- **Blocks and tickets** stay in step. Releasing a block resolves its ticket, and reopening the ticket blocks the room again.
- **Open cleaning tasks** are cancelled when a room goes out of order. Supervisors can also cancel a task.
- **Lost & found** items can be linked to a booking, given a storage place, and marked returned (to whom) or disposed.
- **Daily stay-over cleaning** is on for new hotels.

**Folio, POS and events**
- **Outlet bills** can't be charged to another hotel's guest. Voiding a bill's lines on the folio reopens the bill at the outlet.
- **Billing events to rooms:** events can only be billed to a guest in house, and an event already on a folio can't also get its own invoice.
- **Invoicing events:** an event paid in full by deposit can be invoiced, and closing an event issues its invoice automatically.
- **Cash and refunds:** a cash refund comes out of the right cashier's drawer, and foreign cash is no longer counted as rupees.
- **Bookings:** editing a booking keeps its promo discount, and an early departure lowers the booking total.

**Stock**
- **Voiding a bill** puts its stock back.
- **Below zero** shows "Short: count it".
- **The minibar** is no longer missed or counted twice.
- **Links to other hotels:** an item or location can't be linked to another hotel's records.
- **The housekeeping default location** no longer clears at other hotels.

**Guests, loyalty, notifications and pricing**
- **Loyalty:** cancelling an invoice or issuing a credit note takes back its points, and points no longer depend on who checks the guest out.
- **Guest profiles** include stays shared as a room guest. A guest can't be merged into an erased profile.
- **Nightly jobs:** they no longer re-send to the same guests, and they use each hotel's own settings, wording and figures.
- **Pricing:** a new nightly job runs the pricing rules, and switching every rule off withdraws the old dynamic rates.
- **Exchange rates** can only be changed by head office or an administrator.

**People**
- **Where records are filed:** attendance, leave and biometric punches are filed at the person's own hotel.
- **Roster:** fill and "copy last week" skip approved leave and people who have left.
- **Payroll export** can read the roster.
- **Moving staff** between hotels works.

### Event room blocks (0042)

- **Holding rooms:** an event can hold a block of guest rooms from "Rooms for this event" on its page. You set rooms per type, dates, rate plan, cut-off and who pays. The rooms are bookings in a group linked to the event, so the group's rooming list still applies.
- **Following the event:** the rooms are tentative while the event is quoted and confirmed when it is confirmed. They are cancelled if the event is cancelled, and never expire by the hour.
- **Cut-off:** rooms still without a guest's name at the cut-off go back on sale. The default is 14 days before the event. Night audit releases them on the date, and there is a "Release unsold rooms now" button.
- **Who pays** is set per event:
  - **Each guest:** the room is billed to the guest as usual.
  - **The organiser:** the nights post to an "Organiser" folio that belongs to the event. They count as room revenue in every report and in the event's balance. They are billed on the event's GST invoice as accommodation (SAC 996311), next to the hall and catering (SAC 996334). The guest settles only their own extras, and the event invoice is issued automatically when the last of those rooms checks out.

### Links, validations and dead buttons (0043)

Decisions taken for this round, 12 November:
- **Menus** show only what each person can open. A section link goes to the first tab they can open. Nobody got a new permission.
- **Late charges:** a checked-out stay still takes charges (they go to its "After invoice" folio). A cancelled, no-show or waitlisted booking takes no new charges, only its penalty, a payment of what it owes, credit notes and refunds.
- **Modifiers** may take money off, but never take an item below ₹0.
- **Approved leave:** the employee can withdraw it until its first day; HR (`hr.manage`) can cancel it at any time, with a reason.

**1. Links and routing**
- **`/billing`** now opens the first Billing tab the person can open.
- **One map of who may open each page** (`app/lib/page-access.ts`) drives the sidebar, every section's tabs and the in-page links: ticket → asset and booking, Housekeeping Setup → Staff, Settings and Rates, Data export → Settings, event invoice → credit note, the dashboard alerts and POS order links. Where a person can't open the target, the text stays but isn't a link. A unit test reads every page's guard and fails if the map drifts from it.
- **Checked in the app** with the F&B manager, banquet manager, housekeeping supervisor, maintenance engineer and POS cashier: no link or tab they are shown leads to "access denied".
- **The property switcher** lists open hotels only, and switching into a closed one is refused.
- **Penalties from the folio:** anyone who can cancel bookings can post a cancellation or no-show penalty there, taxed like the stay. On a cancelled booking that is the only charge offered.
- **Stale screens:** the booking and its folio page refresh after POS charge-to-room, event billing and minibar or laundry posting.
- **Not changed:** the packages editor and the staff-profile feedback form. Neither has a broken link; they are noted here so they are not mistaken for one.

**3. Validations**
- **Folio:** closed bookings refuse new charges; undated lines take the business date, so the closed-day lock covers them; refunds are capped at what is owed back; credit notes at what is left of the invoice after allowances and earlier credit notes.
- **Check-in and check-out:** a desk claims a check-out while it runs, so a second desk is told "already being checked out" (the claim lapses after two minutes). A retried check-in doesn't charge the early fee twice. The deposit check counts payments less refunds, not allowances. A folio whose allowances exceed its charges is skipped with a warning instead of blocking check-out.
- **Penalties** are posted before the booking is cancelled or marked a no-show, at the desk and in night audit. If the status change then fails, the penalty is voided, and a rerun of the audit doesn't post it twice.
- **Amending a booking** refuses a check-out before a night already charged, and a move to a past arrival.
- **Feedback** must belong to the booking's guest. **Groups** can't start in the past, and rooms added later get the usual hold time.
- **POS:** a settled bill's tip and room can't change; payment, points and charge-to-room lock the bill; voiding a line on a part-paid bill settles it when nothing is left owing; the room-charge limit counts only what is unpaid on the stay; a modifier can't take an item below ₹0.
- **Events:** changing the price of an approved quotation (package, discount, pax, rental, or a line) clears the approval. Inactive spaces and another space's layouts are refused.
- **Rates:** room and weekend rates must be above ₹0, a discount below 100%, a fixed rate above ₹0. Two active seasons on the same nights, rooms and priority are refused. Two bookings can no longer take the last use of a promo code.
- **HR:** the database recomputes worked hours and refuses a timesheet claiming more (with 15 minutes' margin); an open night shift can be closed in an approved week; approvers can reopen weeks; manual attendance refuses a future clock-out, out = in, and overlaps; leave can't be booked on days already worked; the roster keeps cells on a switched-off shift; roster fill and copy need a Monday; clock-out is never blocked off site (the distance is still recorded).
- **Reports:** scheduling or sending a revenue report needs `reports.financial`, and the nightly job stops sending one whose creator has lost it.

**4. Dead buttons and silent failures**
- **Removed:** the "Offer on the website" toggle on rate plans, and "Corporate" as an allocation channel.
- **Relabelled, not removed:** the promo-code toggle was not dead. It decides whether desk staff without revenue access can see and apply the code (policy `promo_codes_public`). It now reads "Any desk staff can apply it".
- **Report schedules:** Edit loads the schedule's fields, and the flash report can be scheduled.
- **Saving a property** with only `properties.manage` now saves, and says so if nothing was written.
- **Night audit** says plainly that it doesn't close cash shifts.
- **Errors now shown** instead of dropped: ticket resolve and cancel when the room isn't released; housekeeping room-status writes; marking a room inspected without permission; reopening the bill after a payment is reversed; check-out failing after the invoice; HR profile saved at another hotel; deleting a role still used at another hotel (it now names the hotels); and every action in the "thrown away" table (maintenance, housekeeping, HR, template reset, password reset, authenticator removal, allocation delete, payment-request cancel, room-move record, check-in documents and guest details, night-audit room status).
- **Leftover columns** stay, as decided.

**How 0043 was checked**
- **Database:** 20 new assertions (`neon/tests/fixes_0043.sql`), each failing before 0043 and passing after it. The behaviour-test output changes only where the new rules intend: the refund fixture now overpays first, "credit the rest" credits ₹2,100, and the attendance fixture adds a week of worked days.
- **Unit tests:** 455 pass, 25 of them new (`tests/links-and-validations.test.ts`). The type check and lint are clean.
- **In the app**, on a local copy of the demo data: the five role crawls above; a second desk refused during a check-out; a cancelled booking's folio offering only a penalty; an overlapping attendance record refused; approved leave withdrawn by the employee; a schedule's fields loading for editing.
- **Rehearsal** on the demo data, then applied to Neon on 12 November.

### Also found and fixed

- **`is_service_role()` on Neon** checked only the database role, so every nightly job was refused by functions that allow the service role. Scheduled reports would have failed the first time one was due.
- **Same-day turnover:** a room another checked-in guest is in is no longer freed at check-out.
- **Stale page numbers:** an out-of-range `?page=` now goes back to page 1 on every list.
- **The till could not add anything.** Its quantity field (`min=0.001`, `step=1`) made the browser refuse every whole number, including the default 1.

## Still open

Sections 1 (broken links and routing), 3 (missing validations) and 4 (dead buttons and silent failures) are fixed by 0043; see [above](#links-validations-and-dead-buttons-0043). Section 2's four open items were not fixed, by decision (see [Not fixed, by decision](#not-fixed-by-decision)).

### 5. Orphan pages

**None.** All pages have an inbound link, tab or redirect. Some are reachable only by typing the URL for certain roles:
- `/night-audit/[date]` for `folio.view`-only users, such as the POS cashier
- `/front-desk/shifts` for `reports.financial`-only users
- `/events/[id]` for `events.bill`-only users

### 6. Inconsistent numbers

On 7 November one day's figures disagreed across screens. Room revenue read ₹26,821 where the day's real nights came to ₹8,050, and tax read ₹5,752 on most screens but ₹4,412 on the flash report. The room revenue and ADR part is fixed. The definitions below still differ.

| Metric | Status | How it differs |
|---|---|---|
| **Room revenue / ADR** | **Fixed (0040)** | Night audit now closes only the day's own lines. The flash "Rooms" row is still department-based (fees and penalties in, allowances and credit notes netted). |
| **Stock** | **Fixed (0041, 0042)** | Below zero shows "Short: count it". Tills can't sell past zero; the minibar and cleaning still can. |
| **Total revenue** | Partly fixed | Now net of tax everywhere. Dashboard and overview still exclude outlet-paid bills and events, include paid-outs, and don't net allowances or credit notes. The flash report does the opposite. |
| **GST** | Partly fixed | Penalties (0040) and events (0041) are now invoiced, so their tax reaches the GST register. Still open: the tax summary uses the stay date and CGST/SGST only; the register uses the issue date. |
| **Daily report dating** | Open | `report_daily` dates other revenue by the day it was created, but tax and total by stay date, so Revenue ≠ Room + Other. **SQL.** `M/0031` |
| **Paid-outs** | Open | Revenue in the daily report and night audit, excluded in flash and the tax summary. As invoice lines they go into GSTR-1 as 0% supplies with SAC "—" and earn loyalty points. |
| **Tips** | Open | F&B when charged to a room (and a 0% invoice line), excluded when settled at the outlet. |
| **Night-audit outlet takings** | Open | Room-charged POS bills are counted twice. `night-audit-actions.ts` |
| **Occupancy** | Open | The dashboard excludes out-of-order rooms; night audit excludes only out-of-service, and counts "available" after applying tomorrow's blocks. |
| **Arrivals and departures** | Open | Four definitions: dashboard (still due), front desk (incl. late), night audit (checked in only), flash (checked in plus checked out). |
| **Business vs calendar date** | Open | No-shows and night audit use the business date; check-in/out fees, housekeeping, invoices and the dashboard chart use the calendar date. KPI tiles read business date − 1, the 30-day chart is anchored to today. |
| **Invoice page totals** | Open | Don't net credit notes, and read every invoice without paging, so they undercount past about 1,000 a year (PostgREST cap). `billing/invoices/page.tsx` |
| **Event balance on the page** | Open | Ignores credit notes, which the database counts, so the page can offer a payment the database refuses. `lib/events.ts` (`eventBalance`) |
| **Penalty previews** | Open | Show the net amount; the folio posts net plus GST. `bookings/[id]/page.tsx` |
| **"Paid" at check-out** | Open | Includes allowances. |
| **POS "settled today"** | Open | Selected by when the bill was opened, capped at 200 bills; reports select by when it was closed. |
| **Staff counts and hours** | Open | Inactive staff on some screens and not others; hours round to 1 decimal in one place and 2 in another; "Tasks done" depends on the viewer's permissions. |
| **Password rules** | Open | Length and expiry come from the hotel being viewed; lockout limits from the default hotel. |
| **Night audit occupancy and RevPAR** | Open | Out-of-order rooms count as available (found while loading demo data). `night-audit-actions.ts` |

### 7. Security (deferred pass)

- **2FA can be enrolled or removed by an unverified session.** Enrol and remove use `getSession()`, so a password-only or revoked session can do it. There is no limit on code guesses, and removing 2FA isn't logged. `security-actions.ts`
- **The data export and audit export skip the stronger session checks:** revoked or pre-2FA sessions still work. `settings/export/download/route.ts`, `audit/export/route.ts`
- **A `staff.manage` holder can take over the owner's account.** They can reset the password or 2FA on any account through the service role, with no property or superuser check, and can grant superuser. These actions are logged as "System". `actions.ts`
- **Changing your own password can be used to guess passwords:** it checks the current password through an untracked sign-in, so guesses are never throttled. `security-actions.ts`
- **The Security events page shows every hotel's sign-ins to a hotel-level auditor.** `audit/security/page.tsx`
- **Sessions and roles:** the server session lasts 7 days, and the idle timeout is only enforced in the browser. `dashboard.view` is never enforced. Clock-in coordinates can be spoofed.
- **Changes to promos and pricing have no audit trigger.**
- **The Razorpay webhook can credit a folio twice,** because its duplicate check isn't atomic. A gateway refund that fails to post can't be retried.

Fixed since 7 November: removing `all_properties` left live access to the hotel being worked in (0040).

### 8. Integrations pending (by your decision)

These are not connected yet:
- Razorpay payment links and webhook
- real TOTP 2FA (currently `TWO_FACTOR_MODE=demo`)
- SMS (Twilio) and email (Resend)
- door locks, the kitchen ticket display and biometric devices
- GST e-invoicing (IRN)

Until they are, each attempt is logged as "not configured". Nothing above depends on them, except the Razorpay note in section 7.

### 9. Found while loading demo data

- **Company-billed invoices earn the guest loyalty points.** Folio invoices are saved without `company_id`, so the company check in `loyalty_award_for_invoice` never fires. `lib/invoice-issue.ts`
- **Night audit counts out-of-order rooms as available,** which skews occupancy and RevPAR (also listed under section 6). `night-audit-actions.ts`
- **Some pages are slow.** In local dev against the hosted database, the flash report took about 44 s and the dashboard about 10 s. This needs measuring on the deployed app.
- **The flash report's "last year" columns show 0** with no label saying there is no comparison data.

Fixed: same-day room turnover left the room marked available (0040).

### Not fixed, by decision

- **Channel allocations enforced.** Declined on 5 November. The Allocations page no longer says they are enforced.
- **Package and meal-plan revenue split.** Priced meal plans were declined on 5 November.
- **Spare parts against inventory.** Declined on 12 November.
- **A screen for `staff_properties`** (multi-hotel staff access). Deferred to the security pass.

## What is correctly wired

- **Room cycle:** check-in occupies the room, check-out dirties it and raises a cleaning task, and clean → inspect makes it sellable. A room back from a block or maintenance gets a touch-up task. A room another guest is in is never freed.
- **Blocks:** they reduce capacity on every date, and a blocked room can't be assigned. Only a guest in the room stops a block; later stays assigned to it are unassigned. Blocks and their tickets follow each other.
- **Folio and invoice:**
  - One issued invoice per folio.
  - Charges after an invoice go to an "After invoice" folio.
  - The invoice matches the folio line for line, and invoice numbers are claimed atomically, per hotel.
  - Check-out refuses before posting anything it can't finish.
- **Refund caps** apply to folios, refund requests and events, under row locks. Cash refunds land on the paying cashier's shift.
- **Tax:** fees and penalties are taxed at the room's slab. Penalties, events and organiser-paid room nights all reach the GST register.
- **Credit notes** have their own number series and take back loyalty points proportionally. Cancelling an invoice takes back all of its points.
- **Cash shifts:** event money, foreign notes counted separately, and the right cashier's refunds.
- **Stock:**
  - One deduction per bill and per clean.
  - Voiding a bill returns its stock.
  - Tills can't sell past zero, and no item or location can be linked to another hotel's records.
- **Promo redemptions** follow the booking, survive repricing, and are released on cancel or no-show.
- **Multi-property:**
  - Reports, cash shifts, HR records and the nightly jobs are each scoped to their own hotel.
  - Losing access to a hotel ends work there.
  - Outlet bills and events can't cross hotels.
- **People:** timesheet approval recomputes figures from attendance and locks the week. The roster respects approved leave. Removing someone with history suspends them.
- **Navigation:** no redirect loops, and every permission key used in SQL exists in `permissions.ts`.

## Deployment

| | State |
|---|---|
| Hosted database (Neon) | **Up to date.** 43 migrations (`0001`–`0043`); demo data intact and removable with `neon/demo/remove_demo.sql` |
| App code for 0040–0043 | **In the working tree, not committed.** It has to be committed and deployed for the app-side fixes to go live. |
| Nightly jobs | Four in `vercel.json`: reports, maintenance, notifications, pricing |
| Until the code is deployed | The live app runs the old code against the new database. That works, and the database rules (closed bookings, settled bills, timesheet hours, refund and credit-note caps, promo limits) already apply. Not live yet: the menu and link changes, the check-out claim, penalties posted before the status change, the new messages, schedule editing, and the new screens from 0040–0042 (event rooms, the till's "n left", lost & found, cancelling tasks, the bill-to pre-fill, the nightly pricing job). |

## Suggested next steps

1. **Deploy** the 0040–0043 code.
2. **Section 9** (found while loading demo data): the four items still open.
3. **Section 6's definitions.** Agree one definition each for total revenue, occupancy and arrivals, then use it everywhere.
4. **The security pass.**
